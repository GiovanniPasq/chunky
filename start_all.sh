#!/bin/bash

set -e

echo "========================================="
echo "       - Starting All Services    "
echo "========================================="
echo ""

BACKEND_PID=""
FRONTEND_PID=""
PROJECT_ROOT="$(pwd -P)"

port_listener_pids() {
    local port="$1"

    command -v lsof >/dev/null 2>&1 || return 0
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2 }' | sort -u
}

process_command() {
    local pid="$1"

    ps -p "$pid" -o command= 2>/dev/null || true
}

stop_matching_port_owner() {
    local port="$1"
    local label="$2"
    local expected_pattern="$3"
    local owner_pids=""
    local pid=""
    local command_line=""
    local matching_pids=""
    local unexpected_pids=""

    owner_pids="$(port_listener_pids "$port")"
    [ -n "$owner_pids" ] || return 1

    for pid in $owner_pids; do
        command_line="$(process_command "$pid")"
        if [ -n "$command_line" ] && echo "$command_line" | grep -Eq "$expected_pattern"; then
            matching_pids="$matching_pids $pid"
        else
            unexpected_pids="$unexpected_pids $pid"
        fi
    done

    [ -z "$unexpected_pids" ] || return 1
    [ -n "$matching_pids" ] || return 1

    echo "$label port $port is already used by a previous Chunky process. Restarting it..."
    for pid in $matching_pids; do
        terminate_process_tree "$pid"
    done
    for pid in $matching_pids; do
        wait_for_process_exit "$pid"
    done
    return 0
}

show_port_owner() {
    local port="$1"
    local owner_info=""
    local owner_pids=""
    local pid=""
    local command_line=""
    local chunky_pids=""

    if command -v lsof >/dev/null 2>&1; then
        echo ""
        owner_info="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1 || true)"
        if [ -n "$owner_info" ]; then
            echo "Process currently listening on port $port:"
            echo "$owner_info"
            owner_pids="$(port_listener_pids "$port")"
            for pid in $owner_pids; do
                command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
                if [ -n "$command_line" ]; then
                    echo "PID $pid command: $command_line"
                    if echo "$command_line" | grep -q "uvicorn backend.main:app"; then
                        chunky_pids="$chunky_pids $pid"
                    fi
                fi
            done
            if [ -n "$chunky_pids" ]; then
                echo ""
                echo "This looks like a Chunky backend. Stop it with:"
                echo "  kill$chunky_pids"
            elif [ -n "$owner_pids" ]; then
                echo ""
                echo "If this process is stale, stop it with:"
                echo "  kill $owner_pids"
            fi
        else
            echo "No process details were returned for port $port."
            echo "Try running: lsof -nP -iTCP:$port -sTCP:LISTEN"
        fi
        echo ""
    else
        echo ""
        echo "Install lsof or run a platform-specific port check to identify the process using port $port."
        echo ""
    fi
}

terminate_process_tree() {
    local pid="$1"
    local children=""

    [ -n "$pid" ] || return 0
    kill -0 "$pid" 2>/dev/null || return 0

    if command -v pgrep >/dev/null 2>&1; then
        children="$(pgrep -P "$pid" 2>/dev/null || true)"
        for child in $children; do
            terminate_process_tree "$child"
        done
    fi

    kill "$pid" 2>/dev/null || true
}

wait_for_process_exit() {
    local pid="$1"
    local attempt=0

    [ -n "$pid" ] || return 0
    while kill -0 "$pid" 2>/dev/null; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 20 ]; then
            kill -9 "$pid" 2>/dev/null || true
            break
        fi
        sleep 0.25
    done
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    status=$?
    trap - EXIT INT TERM
    echo ""
    echo "Shutting down services..."
    terminate_process_tree "$FRONTEND_PID"
    terminate_process_tree "$BACKEND_PID"
    wait_for_process_exit "$FRONTEND_PID"
    wait_for_process_exit "$BACKEND_PID"
    exit "$status"
}

trap cleanup EXIT INT TERM

wait_for_url() {
    local label="$1"
    local url="$2"
    local pid="$3"

    echo "Waiting for $label to be ready..."
    until curl -s "$url" > /dev/null 2>&1; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "$label failed to start. Check the output above for details." >&2
            exit 1
        fi
        sleep 1
    done
    echo "$label is ready!"
    echo ""
}

can_bind_port() {
    local port="$1"
    local label="$2"

    "$PYTHON_BIN" -c 'import socket, sys
port = int(sys.argv[1])
label = sys.argv[2]
sock = socket.socket()
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    print(f"{label} port {port} is already in use. Stop the existing service or change the port.", file=sys.stderr)
    sys.exit(1)
finally:
    sock.close()
' "$port" "$label"
}

ensure_port_free() {
    local port="$1"
    local label="$2"
    local expected_pattern="$3"

    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        if ! stop_matching_port_owner "$port" "$label" "$expected_pattern"; then
            echo "$label port $port is already in use. Stop the existing service or change the port." >&2
            show_port_owner "$port" >&2
            exit 1
        fi
    fi

    if ! can_bind_port "$port" "$label"; then
        if stop_matching_port_owner "$port" "$label" "$expected_pattern" && can_bind_port "$port" "$label"; then
            return
        fi

        show_port_owner "$port" >&2
        exit 1
    fi
}

# Start backend
echo "Starting FastAPI backend..."
VENV_DIR="${VENV_DIR:-.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
ensure_port_free 8000 "Backend" "uvicorn .*backend\.main:app|backend\.main:app .*uvicorn"
ensure_port_free 5173 "Frontend" "$PROJECT_ROOT/frontend.*vite|vite.*$PROJECT_ROOT/frontend"
if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "Python environment not found. Creating '$VENV_DIR'..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [ ! -f "$VENV_DIR/.requirements-installed" ] || [ requirements.txt -nt "$VENV_DIR/.requirements-installed" ]; then
    echo "Installing Python dependencies..."
    "$VENV_DIR/bin/python" -m pip install --upgrade pip
    "$VENV_DIR/bin/python" -m pip install -r requirements.txt
    touch "$VENV_DIR/.requirements-installed"
fi
"$VENV_DIR/bin/python" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
echo "Backend started (PID: $BACKEND_PID) at http://localhost:8000"
echo ""

# Wait for backend to be ready
wait_for_url "Backend" "http://localhost:8000/api/health" "$BACKEND_PID"

# Start frontend
echo "Starting React frontend..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd frontend

DEPS_MARKER="node_modules/.dependencies-installed"
INSTALL_FRONTEND_DEPS=false
if [ ! -d "node_modules" ] || [ ! -f "$DEPS_MARKER" ]; then
    INSTALL_FRONTEND_DEPS=true
elif [ package.json -nt "$DEPS_MARKER" ]; then
    INSTALL_FRONTEND_DEPS=true
elif [ -f package-lock.json ] && [ package-lock.json -nt "$DEPS_MARKER" ]; then
    INSTALL_FRONTEND_DEPS=true
fi

if [ "$INSTALL_FRONTEND_DEPS" = true ]; then
    echo "Installing frontend dependencies..."
    if [ -f "package-lock.json" ]; then
        npm ci
    else
        npm install
    fi
    touch "$DEPS_MARKER"
fi

npm run dev &
FRONTEND_PID=$!
echo "Frontend started (PID: $FRONTEND_PID) at http://localhost:5173"
echo ""

wait_for_url "Frontend" "http://localhost:5173" "$FRONTEND_PID"

echo "========================================="
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo "  Press Ctrl+C to stop all services"
echo "========================================="

while true; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "Backend stopped unexpectedly." >&2
        exit 1
    fi
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "Frontend stopped unexpectedly." >&2
        exit 1
    fi
    sleep 1
done
