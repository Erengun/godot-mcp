extends Node
## Stands in for every autoload singleton while the worker runs (see
## mcp_worker.gd): the singleton's name exists, so project scripts that use it
## compile, but none of the autoload's own code runs.
