"""DarkFactoryRun Temporal workflow."""
from datetime import timedelta
from temporalio import workflow


@workflow.defn
class DarkFactoryRun:
    """Loop: PickNextTask -> Claim -> PrepareWorkspace -> Execute -> Tests -> PR -> WaitForReview -> Close -> repeat."""

    def __init__(self) -> None:
        self._approval_result: str | None = None  # "approved" | "rejected"

    @workflow.signal(name="Approve")
    def approve(self, decision_id: str, note: str = "") -> None:
        self._approval_result = "approved"

    @workflow.signal(name="Reject")
    def reject(self, decision_id: str, note: str = "") -> None:
        self._approval_result = "rejected"

    @workflow.run
    async def run(
        self,
        repo: str | None = None,
        owner: str = "worker-1",
        ttl_seconds: int = 1800,
        sleep_seconds_when_no_task: int = 300,
        max_idle_seconds: int | None = None,
        skip_pr: bool = False,
    ) -> None:
        workflow.logger.info("DarkFactoryRun started", extra={"owner": owner, "repo": repo, "skip_pr": skip_pr})
        idle_start: float | None = None

        while True:
            # 1. Pick next task
            pick = await workflow.execute_activity(
                "pick_next_task",
                args=[repo, owner],
                start_to_close_timeout=timedelta(seconds=30),
            )

            if pick.get("ticket_id") is None:
                reason = pick.get("reason", "none eligible")
                workflow.logger.info("No task eligible", extra={"reason": reason})
                if max_idle_seconds is not None and idle_start is not None:
                    if workflow.time() - idle_start >= max_idle_seconds:
                        workflow.logger.info("max_idle_seconds exceeded, exiting")
                        return
                await workflow.sleep(timedelta(seconds=sleep_seconds_when_no_task))
                if idle_start is None:
                    idle_start = workflow.time()
                continue

            idle_start = None
            ticket_id = pick["ticket_id"]
            task_spec = pick.get("task_spec", "")

            # 2. Claim
            claimed = await workflow.execute_activity(
                "claim_task",
                args=[ticket_id, owner, ttl_seconds],
                start_to_close_timeout=timedelta(seconds=30),
            )
            if not claimed.get("claimed"):
                workflow.logger.info("Claim failed, retrying pick", extra={"ticket_id": ticket_id})
                continue

            # 3. Prepare workspace (uses WORKSPACE_REPO if set, else workflow repo)
            prep = await workflow.execute_activity(
                "prepare_workspace",
                args=[ticket_id, task_spec, repo],
                start_to_close_timeout=timedelta(minutes=5),
            )
            workspace_path = prep.get("workspace_path", "")
            branch = prep.get("branch", "")
            effective_repo = prep.get("repo") or repo

            # 4. Execute (LangGraph); handle approval interrupt (skip when skip_pr)
            exec_result = await workflow.execute_activity(
                "execute_task_with_lang_graph",
                args=[ticket_id, task_spec, workspace_path, branch],
                start_to_close_timeout=timedelta(hours=1),
            )
            if not skip_pr:
                while exec_result.get("needs_approval") and exec_result.get("decision_id"):
                    decision_id = exec_result["decision_id"]
                    workflow_id = workflow.info().workflow_id
                    await workflow.execute_activity(
                        "patch_run_workflow_id",
                        args=[ticket_id, workflow_id],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    self._approval_result = None
                    await workflow.await_condition(lambda: self._approval_result is not None)
                    if self._approval_result == "rejected":
                        await workflow.execute_activity(
                            "transition_ticket",
                            args=[ticket_id, "Blocked", "Rejected by human", "worker"],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        await workflow.execute_activity(
                            "close_task",
                            args=[ticket_id, owner],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        break
                    exec_result = await workflow.execute_activity(
                        "execute_task_with_lang_graph",
                        args=[ticket_id, task_spec, workspace_path, branch, decision_id],
                        start_to_close_timeout=timedelta(hours=1),
                    )
                if self._approval_result == "rejected":
                    continue
            elif exec_result.get("needs_approval"):
                workflow.logger.info("Execute reported risky; auto-approving (skip_pr)", extra={"ticket_id": ticket_id})

            if not exec_result.get("success"):
                workflow.logger.info("Execute reported fail; running tests and closing (skip_pr)", extra={"ticket_id": ticket_id})

            # 5. Run tests
            await workflow.execute_activity(
                "run_task_tests",
                args=[ticket_id, workspace_path],
                start_to_close_timeout=timedelta(minutes=10),
            )

            # 6 & 7. PR and wait (skipped when skip_pr=True — local-only, changes stay in workspace)
            if skip_pr:
                merged = True
            else:
                pr_result = await workflow.execute_activity(
                    "open_or_update_pr",
                    args=[ticket_id, workspace_path, branch, effective_repo],
                    start_to_close_timeout=timedelta(minutes=5),
                )
                pr_number = pr_result.get("pr_number", 0)

                merged = False
                while True:
                    outcome = await workflow.execute_activity(
                        "wait_for_review_and_ci",
                        args=[ticket_id, pr_number, effective_repo],
                        start_to_close_timeout=timedelta(hours=1),
                    )
                    if outcome == "merged":
                        merged = True
                        break
                    if outcome == "rejected":
                        workflow.logger.info("PR rejected", extra={"ticket_id": ticket_id})
                        await workflow.execute_activity(
                            "transition_ticket",
                            args=[ticket_id, "Blocked", "PR rejected", "worker"],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        await workflow.execute_activity(
                            "close_task",
                            args=[ticket_id, owner],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        break
                    if outcome == "changes_requested":
                        await workflow.execute_activity(
                            "transition_ticket",
                            args=[ticket_id, "InProgress", "Re-addressing review", "worker"],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        await workflow.execute_activity(
                            "execute_task_with_lang_graph",
                            args=[ticket_id, task_spec, workspace_path, branch],
                            start_to_close_timeout=timedelta(hours=1),
                        )
                        await workflow.execute_activity(
                            "run_task_tests",
                            args=[ticket_id, workspace_path],
                            start_to_close_timeout=timedelta(minutes=10),
                        )
                        pr_result = await workflow.execute_activity(
                            "open_or_update_pr",
                            args=[ticket_id, workspace_path, branch, effective_repo],
                            start_to_close_timeout=timedelta(minutes=5),
                        )
                        pr_number = pr_result.get("pr_number", pr_number)
                        continue

            # 8. Close task (when merged or skip_pr)
            if merged:
                await workflow.execute_activity(
                    "close_task",
                    args=[ticket_id, owner],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                workflow.logger.info("Task closed", extra={"ticket_id": ticket_id})
