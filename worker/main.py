"""Run the Dark Factory Temporal worker."""
import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from config import TEMPORAL_HOST, TEMPORAL_TASK_QUEUE
from workflow import DarkFactoryRun
from activities import (
    pick_next_task,
    claim_task,
    prepare_workspace,
    execute_task_with_lang_graph,
    workspace_has_code,
    run_task_tests,
    open_or_update_pr,
    wait_for_review_and_ci,
    patch_run_workflow_id,
    transition_ticket,
    close_task,
)


class _FlushHandler(logging.StreamHandler):
    """StreamHandler that flushes after every record so logs appear in real-time."""
    def emit(self, record):
        super().emit(record)
        self.flush()


async def main() -> None:
    import sys
    handler = _FlushHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))
    logging.root.handlers = [handler]
    logging.root.setLevel(logging.INFO)
    logger = logging.getLogger("worker")

    logger.info("Connecting to Temporal at %s", TEMPORAL_HOST)
    client = await Client.connect(TEMPORAL_HOST)

    worker = Worker(
        client,
        task_queue=TEMPORAL_TASK_QUEUE,
        workflows=[DarkFactoryRun],
        activities=[
            pick_next_task,
            claim_task,
            prepare_workspace,
            execute_task_with_lang_graph,
            workspace_has_code,
            run_task_tests,
            open_or_update_pr,
            wait_for_review_and_ci,
            patch_run_workflow_id,
            transition_ticket,
            close_task,
        ],
    )
    logger.info("Worker started on task queue %s", TEMPORAL_TASK_QUEUE)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
