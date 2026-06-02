#!/usr/bin/env python3
"""
Fetch active vulnerabilities from the S360 Kusto cluster
(shavulnmgmtprdwus / ShaS360) for a given RemediationOwner.

Runs the GetUnifiedS360ActionDetails stored function, filters out NotFound
scan results, orphaned images, and app-service assets, then deduplicates
by (VMSSArmId, VulnerabilityId, ImageId) keeping the most recent scan.

Usage:
    scripts/fetch-vulns.py                       # JSON (default), default owner
    scripts/fetch-vulns.py --format summary      # grouped counts
    scripts/fetch-vulns.py --format table        # pretty-printed rows
    scripts/fetch-vulns.py --owner <guid>        # different owner
    scripts/fetch-vulns.py --out vulns.json      # write JSON to file
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# Reuse the kusto-query skill's helper (az cli + curl, no SDK).
KUSTO_SKILL_SCRIPTS = Path.home() / ".claude" / "skills" / "kusto-query" / "scripts"
sys.path.insert(0, str(KUSTO_SKILL_SCRIPTS))
from kusto_helper import query_kusto, print_results  # noqa: E402

CLUSTER_URL = "https://shavulnmgmtprdwus.westus2.kusto.windows.net"
DATABASE = "ShaS360"
DEFAULT_OWNER = "66fc1dd2-fca0-43fe-a29e-e5019a29e949"

# NOTE: keep the query stable with the one in the S360 portal so results match.
QUERY_TEMPLATE = r"""
GetUnifiedS360ActionDetails
(
    _Filter_RemediationOwner= dynamic(['{owner}'])
)
| where ScanResult != 'NotFound' and VulnerabilityName != 'Orphaned Image' and AssetId !contains "appsvc"
| extend ScopedHoboAsset = isnotempty(InventoryAttributes.ProviderAttributes) and tobool(InventoryAttributes.1pHoboFlag) == 1
| extend VMScaleSetName = tostring(InventoryAttributes.VMScaleSetName)
| extend ResourceGroup = tostring(InventoryAttributes.ResourceGrp)
| extend VMSSArmId = strcat('/subscriptions/',SubscriptionId,'/resourcegroups/',ResourceGroup, '/providers/microsoft.compute/virtualMachineScaleSets/',VMScaleSetName)
| extend LastScanTimeUTC = todatetime(ScanAttributes.ScanCompleteTime)
| extend ScanResult = iff(ScanResult startswith '#table', strcat_array(array_slice(split(ScanResult, '\n'), 2, -1), '\n'), ScanResult)
| summarize arg_max(LastScanTimeUTC, *)
    by AssetId, VulnerabilityId, ImageId
| summarize
    arg_max(LastScanTimeUTC, *),
    VMInstanceCount = count()
    by VMSSArmId, VulnerabilityId, ImageId
| project SLA, DueDate=format_datetime(DueDate, 'yyyy-MM-dd'), ScanResult, ImageId, Image, Environment, Action, AssetType, VulnerabilityName, ResourceGroup, SubscriptionId, AKSCluster, VMScaleSetName, LastScanTimeUTC, ServiceTreeId, LastSeen, VMInstanceCount
| order by DueDate asc
"""


def fetch(owner: str, cluster: str, database: str):
    query = QUERY_TEMPLATE.format(owner=owner)
    return query_kusto(cluster, database, query, timeout=180)


def print_summary(rows):
    if not rows:
        print("No active vulnerabilities for this owner.")
        return

    print(f"Active vulnerabilities: {len(rows)}\n")

    def show(title, counter, top=None):
        items = counter.most_common(top) if top else counter.most_common()
        if not items:
            return
        print(f"{title}:")
        for key, n in items:
            label = key if key else "(none)"
            print(f"  [{n:3d}]  {label}")
        print()

    show("By SLA", Counter(r.get("SLA") or "" for r in rows))
    show("By Environment", Counter(r.get("Environment") or "" for r in rows))
    show("By AssetType", Counter(r.get("AssetType") or "" for r in rows))
    show("By Action", Counter(r.get("Action") or "" for r in rows))
    show("By VulnerabilityName (top 15)",
         Counter(r.get("VulnerabilityName") or "" for r in rows), top=15)
    show("By Image (top 10)",
         Counter(r.get("Image") or "" for r in rows), top=10)
    show("By AKSCluster (top 10)",
         Counter(r.get("AKSCluster") or "" for r in rows), top=10)

    import datetime
    today = datetime.date.today().isoformat()
    overdue = [r for r in rows if (r.get("DueDate") or "9999") < today]
    print(f"Overdue (DueDate < {today}): {len(overdue)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--owner", default=DEFAULT_OWNER,
                    help=f"RemediationOwner GUID (default: {DEFAULT_OWNER})")
    ap.add_argument("--cluster", default=CLUSTER_URL)
    ap.add_argument("--database", default=DATABASE)
    ap.add_argument("--format", choices=["json", "table", "summary"], default="json")
    ap.add_argument("--out", help="Write JSON output to file instead of stdout")
    args = ap.parse_args()

    cols, rows = fetch(args.owner, args.cluster, args.database)

    if args.format == "summary":
        print_summary(rows)
        return
    if args.format == "table":
        print_results(cols, rows, f"Active Vulnerabilities ({len(rows)} rows)")
        return

    payload = json.dumps(rows, default=str, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
        print(f"Wrote {len(rows)} rows to {args.out}", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
