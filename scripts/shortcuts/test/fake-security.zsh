#!/bin/zsh
printf '%s\n' "CALLED" >> "${JOBSCAN_SECURITY_LOG:?}"
exit 1
