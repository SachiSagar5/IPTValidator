#!/bin/bash

# IPTV Validator - Start Script
# Run the app without using `npm run` commands

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the project directory
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Please run this script from the project root directory."
    exit 1
fi

# Parse command line arguments
MODE="dev"
PORT=""
HOST=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --dev|-d)
            MODE="dev"
            shift
            ;;
        --build|-b)
            MODE="build"
            shift
            ;;
        --preview|-p)
            MODE="preview"
            shift
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --host)
            HOST="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: ./start.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dev, -d       Run development server (default)"
            echo "  --build, -b     Build for production"
            echo "  --preview, -p   Preview production build"
            echo "  --port PORT     Specify port (default: 3000 for dev, 4173 for preview)"
            echo "  --host HOST     Specify host (default: localhost)"
            echo "  --help, -h      Show this help message"
            echo ""
            echo "Examples:"
            echo "  ./start.sh                    # Run dev server on localhost:3000"
            echo "  ./start.sh --dev --port 8080  # Run dev server on port 8080"
            echo "  ./start.sh --build            # Build for production"
            echo "  ./start.sh --preview          # Preview production build"
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information."
            exit 1
            ;;
    esac
done

# Detect package manager
if command -v bun &> /dev/null; then
    PKG_MANAGER="bun"
    print_info "Using Bun as package manager"
elif command -v pnpm &> /dev/null; then
    PKG_MANAGER="pnpm"
    print_info "Using pnpm as package manager"
elif command -v yarn &> /dev/null; then
    PKG_MANAGER="yarn"
    print_info "Using yarn as package manager"
else
    PKG_MANAGER="npm"
    print_info "Using npm as package manager"
fi

# Check if node_modules exists, if not install dependencies
if [ ! -d "node_modules" ]; then
    print_warning "node_modules not found. Installing dependencies..."
    $PKG_MANAGER install
    print_success "Dependencies installed"
fi

# Execute based on mode
case $MODE in
    dev)
        DEV_PORT=${PORT:-3000}
        DEV_HOST=${HOST:-"localhost"}
        print_info "Starting development server on http://${DEV_HOST}:${DEV_PORT}"
        
        if [ "$PKG_MANAGER" = "bun" ]; then
            # Use bun to run vite directly
            exec bunx vite dev --port "$DEV_PORT" --host "$DEV_HOST"
        else
            # Use npx/pnpm/yarn to run vite
            exec npx vite dev --port "$DEV_PORT" --host "$DEV_HOST"
        fi
        ;;
    build)
        print_info "Building for production..."
        if [ "$PKG_MANAGER" = "bun" ]; then
            exec bunx vite build
        else
            exec npx vite build
        fi
        ;;
    preview)
        PREVIEW_PORT=${PORT:-4173}
        PREVIEW_HOST=${HOST:-"localhost"}
        print_info "Previewing production build on http://${PREVIEW_HOST}:${PREVIEW_PORT}"
        
        # Check if build exists
        if [ ! -d "dist" ] && [ ! -d "build" ]; then
            print_warning "No production build found. Building first..."
            if [ "$PKG_MANAGER" = "bun" ]; then
                bunx vite build
            else
                npx vite build
            fi
        fi
        
        if [ "$PKG_MANAGER" = "bun" ]; then
            exec bunx vite preview --port "$PREVIEW_PORT" --host "$PREVIEW_HOST"
        else
            exec npx vite preview --port "$PREVIEW_PORT" --host "$PREVIEW_HOST"
        fi
        ;;
esac