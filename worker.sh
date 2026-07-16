#!/bin/sh
# Entrypoint for the procrastinate worker container.
# Passing this as a script avoids az containerapp's --command choking on an
# inline `sh -c "... || true && ..."` (the -c and shell operators break its
# argument parsing). Apply procrastinate's schema (idempotent), then run.
set -e
procrastinate --app=src.tasks.procrastinate_app schema --apply || true
exec procrastinate --app=src.tasks.procrastinate_app worker
