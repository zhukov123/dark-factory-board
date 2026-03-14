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
        skip_human_approval: bool = True,
    ) -> None:
        workflow.logger.info(
            "DarkFactoryRun started",
            extra={"owner": owner, "repo": repo, "skip_human_approval": skip_human_approval},
        )
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
            # When repo is None, pick-next returned any eligible ticket; use that ticket's repo for clone/PR
            ticket_repo = pick.get("repo") or repo

            # 2. Claim
            claimed = await workflow.execute_activity(
                "claim_task",
                args=[ticket_id, owner, ttl_seconds],
                start_to_close_timeout=timedelta(seconds=30),
            )
            if not claimed.get("claimed"):
                workflow.logger.info("Claim failed, retrying pick", extra={"ticket_id": ticket_id})
                continue

            # 3. Prepare workspace (uses WORKSPACE_REPO if set, else ticket_repo)
            prep = await workflow.execute_activity(
                "prepare_workspace",
                args=[ticket_id, task_spec, ticket_repo],
                start_to_close_timeout=timedelta(minutes=5),
            )
            workspace_path = prep.get("workspace_path", "")
            branch = prep.get("branch", "")
            effective_repo = prep.get("repo") or ticket_repo

            # 4. Execute (LangGraph: Planner -> Implementer only; review happens in review_pr after PR is created)
            await workflow.execute_activity(
                "execute_task_with_lang_graph",
                args=[ticket_id, task_spec, workspace_path, branch, None],
                start_to_close_timeout=timedelta(hours=1),
            )

            # 5. Run tests
            await workflow.execute_activity(
                "run_task_tests",
                args=[ticket_id, workspace_path],
                start_to_close_timeout=timedelta(minutes=10),
            )

            # 6. Create PR (Implementer handoff)
            pr_result = await workflow.execute_activity(
                "open_or_update_pr",
                args=[ticket_id, workspace_path, branch, effective_repo, 0],
                start_to_close_timeout=timedelta(minutes=5),
            )
            pr_number = pr_result.get("pr_number", 0)
            cleaned_up = False

            if pr_number <= 0:
                workflow.logger.info("PR creation failed; leaving ticket In Progress", extra={"ticket_id": ticket_id})
                await workflow.execute_activity(
                    "transition_ticket",
                    args=[ticket_id, "InProgress", "PR creation failed", "worker"],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    "close_task",
                    args=[ticket_id, owner, "InProgress"],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                merged = False
            else:
                merged = False
                max_review_rounds = 5
                for round_one in range(max_review_rounds):
                    review_round = round_one + 1
                    review_result = await workflow.execute_activity(
                        "review_pr",
                        args=[ticket_id, pr_number, effective_repo, workspace_path, skip_human_approval, review_round],
                        start_to_close_timeout=timedelta(minutes=10),
                    )
                    verdict = (review_result.get("verdict") or "pass").strip().lower()
                    body = (review_result.get("body") or "").strip()

                    if verdict == "pass":
                        merged = True
                        break
                    if verdict == "fail" or (verdict == "risky" and skip_human_approval):
                        await workflow.execute_activity(
                            "transition_ticket",
                            args=[ticket_id, "InProgress", "Re-addressing review", "worker"],
                            start_to_close_timeout=timedelta(seconds=30),
                        )
                        await workflow.execute_activity(
                            "post_pr_comment",
                            args=[
                                ticket_id,
                                pr_number,
                                effective_repo,
                                "**Implementer** is addressing the review feedback above. Pushing updates and requesting another review.",
                            ],
                            start_to_close_timeout=timedelta(seconds=15),
                        )
                        await workflow.execute_activity(
                            "execute_task_with_lang_graph",
                            args=[ticket_id, task_spec, workspace_path, branch, body],
                            start_to_close_timeout=timedelta(hours=1),
                        )
                        await workflow.execute_activity(
                            "run_task_tests",
                            args=[ticket_id, workspace_path],
                            start_to_close_timeout=timedelta(minutes=10),
                        )
                        pr_result = await workflow.execute_activity(
                            "open_or_update_pr",
                            args=[ticket_id, workspace_path, branch, effective_repo, pr_number],
                            start_to_close_timeout=timedelta(minutes=5),
                        )
                        pr_number = pr_result.get("pr_number", pr_number)
                        if pr_number <= 0:
                            break
                        continue
                    if verdict == "risky" and not skip_human_approval:
                        decision_id = review_result.get("decision_id")
                        if decision_id:
                            workflow_id = workflow.info().workflow_id
                            await workflow.execute_activity(
                                "patch_run_workflow_id",
                                args=[ticket_id, workflow_id],
                                start_to_close_timeout=timedelta(seconds=30),
                            )
                            self._approval_result = None
                            _wait = getattr(workflow, "wait_condition", None) or workflow.await_condition
                            await _wait(lambda: self._approval_result is not None)
                            if self._approval_result == "rejected":
                                await workflow.execute_activity(
                                    "transition_ticket",
                                    args=[ticket_id, "Blocked", "Rejected by human", "worker"],
                                    start_to_close_timeout=timedelta(seconds=30),
                                )
                                await workflow.execute_activity(
                                    "close_task",
                                    args=[ticket_id, owner, "Blocked"],
                                    start_to_close_timeout=timedelta(seconds=30),
                                )
                                await workflow.execute_activity(
                                    "cleanup_workspace",
                                    args=[workspace_path],
                                    start_to_close_timeout=timedelta(seconds=60),
                                )
                                cleaned_up = True
                                merged = False
                                break
                            await workflow.execute_activity(
                                "merge_pr",
                                args=[ticket_id, pr_number, effective_repo],
                                start_to_close_timeout=timedelta(seconds=30),
                            )
                            merged = True
                        break
                if not merged and not review_result.get("needs_approval"):
                    workflow.logger.info("Review rounds exhausted; leaving ticket In Progress", extra={"ticket_id": ticket_id})
                    await workflow.execute_activity(
                        "close_task",
                        args=[ticket_id, owner, "InProgress"],
                        start_to_close_timeout=timedelta(seconds=30),
                    )

            # 8. Close task (only when PR merged; PR-failed leaves ticket In Progress)
            if merged:
                await workflow.execute_activity(
                    "close_task",
                    args=[ticket_id, owner],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                workflow.logger.info("Task closed", extra={"ticket_id": ticket_id})

            # 9. Cleanup workspace (skip if already cleaned e.g. on human reject)
            if not cleaned_up:
                await workflow.execute_activity(
                    "cleanup_workspace",
                    args=[workspace_path],
                    start_to_close_timeout=timedelta(seconds=60),
                )
