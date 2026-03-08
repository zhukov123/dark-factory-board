"""Worker configuration from environment."""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


TASKBOARD_URL = os.environ.get("TASKBOARD_URL", "http://localhost:5000").rstrip("/")
TASKBOARD_TOKEN = os.environ.get("TASKBOARD_TOKEN", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
REPO_CLONE_ROOT = os.environ.get("REPO_CLONE_ROOT", "/tmp/dark-factory-workspaces")
# When set, this repo is used as the workspace for all tasks (clone + PR target). Overrides workflow/ticket repo.
WORKSPACE_REPO = os.environ.get("WORKSPACE_REPO", "").strip()  # e.g. owner/repo or https://github.com/owner/repo.git
# When set, this local directory is used as the workspace (no clone). Must be a git repo. One task at a time. All changes happen here.
WORKSPACE_PATH = os.environ.get("WORKSPACE_PATH", "").strip()  # e.g. /Users/you/Code/GitHub/factory-workspace-1
# When true (1), skip open PR and wait-for-review; just run Execute -> Tests -> Close. Use for local-only runs.
SKIP_PR = os.environ.get("SKIP_PR", "").strip().lower() in ("1", "true", "yes")
TEMPORAL_HOST = os.environ.get("TEMPORAL_HOST", "localhost:7233")
TEMPORAL_TASK_QUEUE = os.environ.get("TEMPORAL_TASK_QUEUE", "dark-factory")
SLEEP_SECONDS_WHEN_NO_TASK = int(os.environ.get("SLEEP_SECONDS_WHEN_NO_TASK", "300"))
MAX_IDLE_SECONDS = os.environ.get("MAX_IDLE_SECONDS")  # None = run until cancelled
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")

# LM Studio (local OpenAI-compatible server). If set, overrides OpenRouter when OPENROUTER_API_KEY is not set.
LMSTUDIO_BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "").rstrip("/")  # e.g. http://localhost:1234/v1
LMSTUDIO_MODEL = os.environ.get("LMSTUDIO_MODEL", "local")  # model name as shown in LM Studio
