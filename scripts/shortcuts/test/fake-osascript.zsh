#!/bin/zsh
printf '%s\n' "${@[-1]}" >> "${JOBSCAN_NOTIFY_LOG:?}"
