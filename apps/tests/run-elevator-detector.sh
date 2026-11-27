#!/bin/sh
# Compiles the elevator detector with its cases and runs them on the Mac.
set -e
cd "$(dirname "$0")/.."
out="$(mktemp -d)/elevator-detector"
swiftc -O -o "$out" Sources/ElevatorDetector.swift tests/main.swift
"$out"
