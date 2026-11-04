#!/bin/bash
# usage: rotate.sh landscape-left|landscape-right|portrait
case "$1" in landscape-left) T=testLandscapeLeft;; landscape-right) T=testLandscapeRight;; portrait) T=testPortrait;; *) echo "usage: rotate.sh landscape-left|landscape-right|portrait"; exit 2;; esac
exec "$(dirname "${BASH_SOURCE[0]}")/_run.sh" $T
