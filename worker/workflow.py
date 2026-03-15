"""DarkFactoryRun Temporal workflow."""
from datetime import timedelta
from temporalio import workflow


def _token_overlap(a: str, b: str) -> float:
    """Jaccard similarity of word tokens between two strings."""
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def _feedback_is_repetitive(bodies: list[str], k: int = 3, threshold: float = 0.70) -> bool:
    """Return True if the last K review bodies are pairwise similar above threshold."""
    if len(bodies) < k:
        return False
    recent = bodies[-k:]
    for i in range(k):
        for j in range(i + 1, k):
            if _token_overlap(recent[i], recent[j]) < threshold:
                return False
    return True


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

            # 5. Run tests; on failure, route back to implementer with test output as feedback
            max_test_fix_rounds = 5
            tests_passed = False
            test_failure_bodies: list[str] = []
            for test_round in range(max_test_fix_rounds):
                test_result = await workflow.execute_activity(
                    "run_task_tests",
                    args=[ticket_id, workspace_path],
                    start_to_close_timeout=timedelta(minutes=10),
                )
                if test_result.get("success"):
                    tests_passed = True
                    break
                log_excerpt = (test_result.get("log_excerpt") or "No log captured.").strip()
                test_failure_bodies.append(log_excerpt)
                last_n = test_failure_bodies[-3:]
                parts = []
                for idx, excerpt in enumerate(last_n):
                    round_label = test_round - len(last_n) + idx + 2
                    parts.append(f"Test round {round_label} output:\n{excerpt}")
                test_feedback = "Build or tests failed. Fix the errors below.\n\n" + "\n\n".join(parts)
                await workflow.execute_activity(
                    "transition_ticket",
                    args=[ticket_id, "InProgress", "Build or tests failed; re-running implementer", "worker"],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    "execute_task_with_lang_graph",
                    args=[ticket_id, task_spec, workspace_path, branch, test_feedback],
                    start_to_close_timeout=timedelta(hours=1),
                )

            if not tests_passed:
                workflow.logger.info(
                    "Test fix rounds exhausted; re-queuing ticket as Ready",
                    extra={"ticket_id": ticket_id},
                )
                await workflow.execute_activity(
                    "close_task",
                    args=[ticket_id, owner, "Ready", "Build or tests failed after retries"],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                continue

            # 6. Create PR (Implementer handoff)
            pr_result = await workflow.execute_activity(
                "open_or_update_pr",
                args=[ticket_id, workspace_path, branch, effective_repo, 0],
                start_to_close_timeout=timedelta(minutes=5),
            )
            pr_number = pr_result.get("pr_number", 0)
            cleaned_up = False

            if pr_number <= 0:
                workflow.logger.info("PR creation failed; re-queuing ticket as Ready", extra={"ticket_id": ticket_id})
                await workflow.execute_activity(
                    "close_task",
                    args=[ticket_id, owner, "Ready", "PR creation failed"],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                merged = False
            else:
                merged = False
                closed_due_to_test_failure = False
                max_review_rounds = 7
                review_bodies: list[str] = []
                for round_one in range(max_review_rounds):
                    review_round = round_one + 1
                    review_result = await workflow.execute_activity(
                        "review_pr",
                        args=[ticket_id, pr_number, effective_repo, workspace_path, skip_human_approval, review_round],
                        start_to_close_timeout=timedelta(minutes=10),
                    )
                    verdict = (review_result.get("verdict") or "pass").strip().lower()
                    body = (review_result.get("body") or "").strip()
                    remaining_issues = (review_result.get("remaining_issues") or "").strip()

                    feedback_for_history = remaining_issues or body
                    if feedback_for_history:
                        review_bodies.append(feedback_for_history)

                    if verdict == "pass":
                        merged = True
                        break
                    if verdict == "fail" or (verdict == "risky" and skip_human_approval):
                        if _feedback_is_repetitive(review_bodies):
                            workflow.logger.info(
                                "Repetitive review feedback detected; blocking ticket",
                                extra={"ticket_id": ticket_id, "rounds": review_round},
                            )
                            await workflow.execute_activity(
                                "close_task",
                                args=[ticket_id, owner, "Blocked", "Review loop: same feedback repeated 3 times — needs human attention or ticket decomposition"],
                                start_to_close_timeout=timedelta(seconds=30),
                            )
                            merged = False
                            closed_due_to_test_failure = True
                            break

                        last_n = review_bodies[-3:]
                        combined_feedback_parts = []
                        for idx, fb in enumerate(last_n):
                            round_label = review_round - len(last_n) + idx + 1
                            combined_feedback_parts.append(f"Round {round_label} review:\n{fb}")
                        combined_feedback = "\n\n".join(combined_feedback_parts)

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
                            args=[ticket_id, task_spec, workspace_path, branch, combined_feedback],
                            start_to_close_timeout=timedelta(hours=1),
                        )
                        tests_passed_after_review = False
                        post_review_test_failures: list[str] = []
                        for test_round_pr in range(max_test_fix_rounds):
                            test_result = await workflow.execute_activity(
                                "run_task_tests",
                                args=[ticket_id, workspace_path],
                                start_to_close_timeout=timedelta(minutes=10),
                            )
                            if test_result.get("success"):
                                tests_passed_after_review = True
                                break
                            log_excerpt = (test_result.get("log_excerpt") or "No log captured.").strip()
                            post_review_test_failures.append(log_excerpt)
                            last_n = post_review_test_failures[-3:]
                            parts = []
                            for idx, excerpt in enumerate(last_n):
                                round_label = test_round_pr - len(last_n) + idx + 2
                                parts.append(f"Test round {round_label} output:\n{excerpt}")
                            test_feedback = "Build or tests failed. Fix the errors below.\n\n" + "\n\n".join(parts)
                            await workflow.execute_activity(
                                "transition_ticket",
                                args=[ticket_id, "InProgress", "Build or tests failed; re-running implementer", "worker"],
                                start_to_close_timeout=timedelta(seconds=30),
                            )
                            await workflow.execute_activity(
                                "execute_task_with_lang_graph",
                                args=[ticket_id, task_spec, workspace_path, branch, test_feedback],
                                start_to_close_timeout=timedelta(hours=1),
                            )
                        if not tests_passed_after_review:
                            workflow.logger.info(
                                "Test fix rounds exhausted after review; blocking ticket",
                                extra={"ticket_id": ticket_id},
                            )
                            await workflow.execute_activity(
                                "close_task",
                                args=[ticket_id, owner, "Blocked", "Build or tests failed after retries"],
                                start_to_close_timeout=timedelta(seconds=30),
                            )
                            merged = False
                            closed_due_to_test_failure = True
                            break
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
                if not merged and not review_result.get("needs_approval") and not closed_due_to_test_failure:
                    workflow.logger.info("Review rounds exhausted; blocking ticket", extra={"ticket_id": ticket_id})
                    await workflow.execute_activity(
                        "close_task",
                        args=[ticket_id, owner, "Blocked", "Review rounds exhausted — needs human attention"],
                        start_to_close_timeout=timedelta(seconds=30),
                    )

            # 8. Close task (only when PR merged; failure paths already re-queued ticket as Ready)
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
