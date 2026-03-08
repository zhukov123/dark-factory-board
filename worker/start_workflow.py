"""Start one DarkFactoryRun workflow (for use when Temporal CLI is not installed)."""
import asyncio
import time
from temporalio.client import Client

from config import TEMPORAL_HOST, TEMPORAL_TASK_QUEUE, SKIP_PR
from workflow import DarkFactoryRun


async def main() -> None:
    client = await Client.connect(TEMPORAL_HOST)
    # repo filters pick-next; sleep 60 when no task; exit after 1h idle; skip_pr from SKIP_PR env
    handle = await client.start_workflow(
        DarkFactoryRun.run,
        args=[
            "task-manager-react",  # repo
            "worker-1",            # owner
            1800,                  # ttl_seconds
            60,                    # sleep_seconds_when_no_task
            3600,                  # max_idle_seconds
            SKIP_PR,               # skip_pr — no PR/push, changes only in WORKSPACE_PATH
        ],
        id=f"dark-factory-{int(time.time())}",
        task_queue=TEMPORAL_TASK_QUEUE,
    )
    print(f"Started workflow: {handle.id}")
    print(f"Watch in Temporal UI: http://localhost:8080 (Workflows -> {handle.id})")


if __name__ == "__main__":
    asyncio.run(main())
