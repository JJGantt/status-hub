#!/bin/sh
# Compiles the elevator detector and the near-home trace's accuracy policy with their cases and runs them
# on the Mac.
set -e
cd "$(dirname "$0")/.."
out="$(mktemp -d)/elevator-detector"
swiftc -O -o "$out" Sources/ElevatorDetector.swift Sources/TracePolicy.swift tests/main.swift
"$out"
