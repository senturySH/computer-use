#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/bin"

mkdir -p "$OUT_DIR"

echo "Building cursor-overlay..."
swiftc -O \
    -framework Cocoa \
    -framework Foundation \
    -o "$OUT_DIR/cursor-overlay" \
    "$SCRIPT_DIR/cursor-overlay.swift"

echo "Building window-capture..."
swiftc -O \
    -framework Foundation \
    -framework CoreGraphics \
    -o "$OUT_DIR/window-capture" \
    "$SCRIPT_DIR/window-capture.swift"

echo "Built: $OUT_DIR/cursor-overlay"
echo "Built: $OUT_DIR/window-capture"
