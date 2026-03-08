"""Terminate all DarkFactoryRun workflows on the task queue (or all but the latest).
Useful to stop old runs so only one workflow processes tickets.
Usage: python terminate_old_workflows.py [--keep-latest]
"""
import asyncio
import argparse
from temporalio.client import Client

from config import TEMPORAL_HOST, TEMPORAL_TASK_QUEUE


async def main() -> None:
    parser = argparse.ArgumentParser(description="Terminate dark-factory workflows")
    parser.add_argument("--keep-latest", action="store_true", help="Keep the most recent workflow, terminate the rest")
    args = parser.parse_args()

    client = await Client.connect(TEMPORAL_HOST)
    workflows = []
    async for wf in client.list_workflows():
        if wf.id.startswith("dark-factory-"):
            workflows.append((wf.id, wf.run_id))

    # Sort by id (timestamp at end) so newest last when keep-latest
    workflows.sort(key=lambda x: x[0])
    if not workflows:
        print("No dark-factory workflows found.")
        return

    to_terminate = workflows[:-1] if args.keep_latest and len(workflows) > 1 else workflows
    if args.keep_latest and len(workflows) > 1:
        print(f"Keeping latest: {workflows[-1][0]}")
    for wf_id, run_id in to_terminate:
        try:
            handle = client.get_workflow_handle(wf_id, run_id=run_id)
            await handle.terminate(reason="Terminated by terminate_old_workflows.py")
            print(f"Terminated: {wf_id}")
        except Exception as e:
            print(f"Failed to terminate {wf_id}: {e}")
    print(f"Done. Terminated {len(to_terminate)} workflow(s).")


if __name__ == "__main__":
    asyncio.run(main())
