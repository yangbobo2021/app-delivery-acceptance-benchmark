import argparse
import csv
import json
import re
import sys
from .totals import add_amount

def calculate(path):
    totals = {}
    count = 0
    with open(path, encoding="utf-8", newline="") as source:
        rows = csv.reader(source, strict=True)
        if next(rows, None) != ["account", "amount_cents"]:
            raise ValueError("Invalid CSV header")
        for row in rows:
            if len(row) != 2 or not re.fullmatch(r"[A-Za-z0-9]+", row[0]) or not re.fullmatch(r"[0-9]+", row[1]):
                raise ValueError("Invalid CSV record")
            amount = int(row[1])
            if amount > 1000000000:
                raise ValueError("Amount out of range")
            totals[row[0]] = add_amount(totals.get(row[0], 0), amount)
            count += 1
    if not count:
        raise ValueError("No data rows")
    return {"totals": totals, "row_count": count}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        result = calculate(args.input)
    except (OSError, ValueError, csv.Error, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
