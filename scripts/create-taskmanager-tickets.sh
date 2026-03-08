#!/usr/bin/env bash
# Create task management web app tickets with detailed descriptions.
# Usage: ./scripts/create-taskmanager-tickets.sh http://localhost:5005 dev-token

set -e
API="${1:-http://localhost:5005}"
TOKEN="${2:-dev-token}"
H="Authorization: Bearer $TOKEN"

curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Set up React app and project structure for the task management web app",
  "status": "Ready",
  "priority": 1,
  "repo": "task-manager-react",
  "description": "Create a new React application that will become the task management web app. Use Vite with React and TypeScript for fast development and type safety. Set up a clear folder structure: src/components for reusable UI (e.g. TaskList, TaskItem, AddTaskForm), src/hooks for custom hooks (e.g. useTasks), src/App.tsx as the root, and a minimal index.html and main entry. Include a basic CSS file or CSS module setup. The app should run with npm install && npm run dev and display a placeholder heading such as \"Task Manager\" so we can confirm the stack works before adding features.",
  "acceptance_criteria": [
    "Project is created with Vite + React + TypeScript",
    "npm install and npm run dev succeed",
    "App shows a visible placeholder (e.g. heading \"Task Manager\") in the browser",
    "Folder structure includes src/components, src/hooks, and clear entry (main.tsx or main.jsx)"
  ],
  "test_plan": "Run npm run dev and open in browser; run npm run build to ensure production build works."
}'

curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Implement task list view with in-memory state",
  "status": "Ready",
  "priority": 2,
  "repo": "task-manager-react",
  "description": "Add the core task list view to the React app. Tasks are stored in React state (useState) for now; no backend or persistence yet. Each task has at least: id (string), title (string), and completed (boolean). Create a Task type/interface and a list of initial tasks (e.g. 2–3 sample tasks) so the UI is visible. Render the list in a component (e.g. TaskList) that maps over tasks and shows each with its title and completed state. Use a checkbox or similar to display completed; no need to toggle yet. Ensure the list is visible on the main screen and the layout is readable (e.g. list or card layout).",
  "acceptance_criteria": [
    "Task type/interface is defined with id, title, completed",
    "Initial task list is in component state and rendered on screen",
    "Each task shows title and completed status (e.g. checkbox or label)",
    "TaskList (or equivalent) component is used and the app compiles without errors"
  ],
  "test_plan": "Manual: run app, confirm list and sample tasks render. Optional: add a simple test that checks TaskList renders given mock tasks."
}'

curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Add form to create new tasks",
  "status": "Ready",
  "priority": 3,
  "repo": "task-manager-react",
  "description": "Add a form (input + button or submit) so the user can create a new task. The form should have a text input for the task title and a submit button (e.g. \"Add\" or \"Add task\"). On submit, add a new task to the in-memory list with a unique id (e.g. crypto.randomUUID() or Date.now().toString()), the entered title, and completed: false. Clear the input after adding. Validate that the title is non-empty (trim whitespace) and do not add empty tasks. The new task must appear immediately in the task list below the form. Use controlled input and handle Enter key to submit as well as the button click.",
  "acceptance_criteria": [
    "Form has text input and submit button",
    "Submitting adds a new task to the list with unique id, title, and completed false",
    "Input is cleared after add; empty or whitespace-only title is rejected",
    "New task appears in the list immediately; Enter key also submits"
  ],
  "test_plan": "Manual: add several tasks, confirm they appear and input clears. Try empty submit and confirm no blank task is added."
}'

curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Add ability to mark tasks complete and delete tasks",
  "status": "Ready",
  "priority": 4,
  "repo": "task-manager-react",
  "description": "Implement two actions on each task: (1) Toggle completed — clicking the checkbox (or equivalent) for a task should flip its completed state and update the list (e.g. visual change like strikethrough or different style for completed tasks). (2) Delete — each task row should have a delete button or icon; clicking it removes that task from the list. State must be updated immutably (e.g. filter out the task by id for delete, map to new array with one task toggled for complete). Ensure the UI reflects changes immediately and there are no console errors.",
  "acceptance_criteria": [
    "Checkbox (or control) toggles task completed state; list updates and completed tasks are visually distinct",
    "Delete control removes the task from the list",
    "Updates are done immutably; no direct mutation of state arrays",
    "UI updates immediately with no errors"
  ],
  "test_plan": "Manual: toggle several tasks, delete one, confirm list and counts update correctly."
}'

curl -s -X POST "$API/tickets" -H "$H" -H "Content-Type: application/json" -d '{
  "title": "Add filter: show All, Active, or Completed tasks",
  "status": "Ready",
  "priority": 5,
  "repo": "task-manager-react",
  "description": "Add a simple filter so the user can switch between viewing all tasks, only active (completed false), or only completed (completed true). Use three buttons or links (e.g. \"All\", \"Active\", \"Completed\") above or beside the task list. Store the current filter in state (e.g. \"all\" | \"active\" | \"completed\") and derive the visible list from the full task list based on the filter. Active filter should be visually indicated (e.g. selected style). The task list component should only receive and render the filtered list so the count and items match the selected filter.",
  "acceptance_criteria": [
    "Three filter options: All, Active, Completed",
    "Visible task list updates when filter changes",
    "Active filter is visually indicated",
    "Filtering is derived from state (no duplicate lists)"
  ],
  "test_plan": "Manual: add mix of completed and active tasks; switch filters and confirm displayed list and counts match."
}'

echo ""
echo "Created 5 tickets. Fetching IDs and setting dependencies..."
sleep 1
# Get ticket IDs sorted so first created = first in list (T80, T81, ...)
IDs=$(curl -s -H "$H" "$API/tickets?limit=10" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = sorted(d['items'], key=lambda t: t['id'])
print(' '.join(t['id'] for t in items))
")
echo "Ticket IDs (order): $IDs"
arr=($IDs)
for i in "${!arr[@]}"; do
  if [ $i -gt 0 ]; then
    prev="${arr[$((i-1))]}"
    curr="${arr[$i]}"
    curl -s -X PUT "$API/tickets/$curr/deps" -H "$H" -H "Content-Type: application/json" -d "{\"blocked_by\": [\"$prev\"]}" -o /dev/null
    echo "  $curr blocked_by $prev"
  fi
done
echo "Done."
