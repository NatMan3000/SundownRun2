#!/bin/bash
# usage: tap.sh x y   (points from the window's top-left, current orientation; about 3 minutes on a live game page)
TEST_RUNNER_X=$1 TEST_RUNNER_Y=$2 exec "$(dirname "${BASH_SOURCE[0]}")/_run.sh" testTap
