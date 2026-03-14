"""Start one DarkFactoryRun workflow (for use when Temporal CLI is not installed)."""
import asyncio
import time
from temporalio.client import Client

from config import TEMPORAL_HOST, TEMPORAL_TASK_QUEUE, SKIP_HUMAN_APPROVAL
from workflow import DarkFactoryRun


async def main() -> None:
    client = await Client.connect(TEMPORAL_HOST)
    # repo: None = pick any eligible ticket and use that ticket's repo for clone/PR; set to e.g. "task-manager-react" to filter
    handle = await client.start_workflow(
        DarkFactoryRun.run,
        args=[
            None,                  # repo (None = dynamic: any ticket, use ticket's repo)
            "worker-1",            # owner
            1800,                  # ttl_seconds
            60,                    # sleep_seconds_when_no_task
            3600,                  # max_idle_seconds
            SKIP_HUMAN_APPROVAL,   # skip_human_approval — risky routes back to implementer, no pause
        ],
        id=f"dark-factory-{int(time.time())}",
        task_queue=TEMPORAL_TASK_QUEUE,
    )
    print(f"Started workflow: {handle.id}")
    print(f"Watch in Temporal UI: http://localhost:8080 (Workflows -> {handle.id})")


if __name__ == "__main__":
    asyncio.run(main())
