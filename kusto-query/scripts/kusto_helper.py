"""Compatibility shim — kusto helper moved to the `msapi` package.

The implementation now lives in `msapi.kusto` (pip install -e ~/Projects/msapi).
This module re-exports it so existing importers keep working:

    from kusto_helper import query_kusto, mgmt_kusto, list_tables, show_schema

New code should import from `msapi.kusto` directly.
"""
from msapi.kusto import (  # noqa: F401
    get_token,
    query_kusto,
    mgmt_kusto,
    list_tables,
    show_schema,
    print_results,
)
