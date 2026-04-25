#!/bin/bash

echo "========================================="
echo "       - Starting All Services    "
echo "========================================="
echo ""

cleanup() {
    echo ""
    echo "Shutting down services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit
}

trap cleanup EXIT INT TERM

# Start backend
echo "Starting FastAPI backend..."
source venv/bin/activate
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
echo "Backend started (PID: $BACKEND_PID) at http://localhost:8000"
echo ""

# Wait for backend to be ready
echo "Waiting for backend to be ready..."
until curl -s http://localhost:8000/health > /dev/null 2>&1; do
    sleep 1
done
echo "Backend is ready!"
echo ""

# Start frontend
echo "Starting React frontend..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd frontend

if [ ! -d "node_modules" ]; then
    echo "node_modules not found. Installing dependencies..."
    npm install
fi

npm run dev &
FRONTEND_PID=$!
echo "Frontend started (PID: $FRONTEND_PID) at http://localhost:5173"
echo ""

echo "========================================="
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo "  Press Ctrl+C to stop all services"
echo "========================================="

wait