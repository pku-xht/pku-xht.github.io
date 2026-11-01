"""Normalize an offline WordPress daily counter export against a cutover baseline."""
import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

from capture_public_visits import validate_output

MAX_SAFE = 9007199254740991
HEADER = ['ID', 'last_visit', 'last_counter', 'visit']
INTEGER = re.compile(r'[0-9]+\Z', re.ASCII)
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}\Z', re.ASCII)
INSTANT = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z', re.ASCII)


def safe_integer(value, label):
    if not isinstance(value, str) or not INTEGER.fullmatch(value):
        raise ValueError(f'invalid {label}')
    number = int(value)
    if number > MAX_SAFE:
        raise ValueError(f'{label} exceeds JavaScript safe integer')
    return number


def parse_date(value):
    if not DATE.fullmatch(value):
        raise ValueError('invalid date')
    return date.fromisoformat(value)


def read_export(path, expected_total=None):
    rows = {}
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('CSV is too large')
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.reader(stream, strict=True)
        if next(reader, None) != HEADER:
            raise ValueError('invalid CSV header')
        for row in reader:
            if len(row) != len(HEADER):
                raise ValueError('invalid CSV row')
            identity, last_visit, last_counter, visit = row
            if not INTEGER.fullmatch(identity) or int(identity) <= 0:
                raise ValueError('invalid ID')
            day = parse_date(last_counter)
            # Older WP Statistics rows can contain this MySQL zero sentinel.
            # The daily bucket is the independently validated last_counter.
            if last_visit != '0000-00-00 00:00:00':
                try:
                    timestamp = datetime.fromisoformat(last_visit)
                except ValueError as error:
                    raise ValueError('invalid last_visit') from error
                if timestamp.date() != day or not re.match(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}', last_visit):
                    raise ValueError('last_visit does not match last_counter')
            if day in rows:
                raise ValueError('duplicate date')
            rows[day] = safe_integer(visit, 'visit')
    if not rows or sum(rows.values()) > MAX_SAFE or (expected_total is not None and sum(rows.values()) != expected_total):
        raise ValueError('CSV total does not match expected export total')
    return rows


def prepare(input_path, baseline_path, expected_total, compare_path=None):
    baseline = json.loads(baseline_path.read_text(encoding='utf-8'))
    site_base = baseline.get('site_base')
    captured_at = baseline.get('captured_at')
    if type(site_base) is not int or not 0 <= site_base <= MAX_SAFE:
        raise ValueError('invalid site_base')
    if not isinstance(captured_at, str) or not INSTANT.fullmatch(captured_at):
        raise ValueError('invalid captured_at')
    instant = datetime.fromisoformat(captured_at.replace('Z', '+00:00'))
    cutover = instant.astimezone(timezone(timedelta(hours=8))).date()
    rows = read_export(input_path, expected_total)
    if compare_path is not None:
        # A second export can contain later visits after the cutover. Only its
        # historical prefix must agree with the independently total-checked CSV.
        comparison = read_export(compare_path)
        if {k: v for k, v in rows.items() if k <= cutover} != {k: v for k, v in comparison.items() if k <= cutover}:
            raise ValueError('exports disagree through cutover date')
    if cutover not in rows:
        raise ValueError('cutover date missing from CSV')
    first = min(rows)
    days = (cutover - first).days + 1
    if not 1 <= days <= 20000:
        raise ValueError('invalid history date range')
    prior = sum(value for day, value in rows.items() if day < cutover)
    cutover_visits = site_base - prior
    if not 0 <= cutover_visits <= rows[cutover]:
        raise ValueError('baseline cannot be reconciled with cutover count')
    items = []
    for i in range(days):
        day = first + timedelta(days=i)
        items.append({'date': day.isoformat(), 'visits': cutover_visits if day == cutover else rows.get(day), 'partial': i == 0 or day == cutover})
    if sum(item['visits'] or 0 for item in items) != site_base:
        raise ValueError('normalized total does not equal baseline')
    result = {'version': 1, 'timezone': 'Asia/Shanghai', 'captured_at': captured_at, 'site_base': site_base, 'first_date': first.isoformat(), 'cutover_date': cutover.isoformat(), 'items': items}
    summary = {'rows': len(rows), 'first_date': first.isoformat(), 'cutover_date': cutover.isoformat(), 'missing_days': sum(item['visits'] is None for item in items), 'cutover_visits': cutover_visits, 'source_total': sum(rows.values()), 'normalized_total': site_base}
    return result, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--timezone', required=True, choices=['Asia/Shanghai'])
    parser.add_argument('--expected-export-total', required=True)
    parser.add_argument('--compare-input', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--private-archive-output', action='store_true')
    args = parser.parse_args()
    try:
        expected = safe_integer(args.expected_export_total, 'expected export total')
        output = validate_output(args.output, args.private_archive_output)
        result, summary = prepare(args.input, args.baseline, expected, args.compare_input)
        encoded = (json.dumps(result, ensure_ascii=True, indent=2) + '\n').encode('utf-8')
        with output.open('xb') as stream:
            stream.write(encoded)
        summary.update(sha256=hashlib.sha256(encoded).hexdigest(), network_requests=0)
        print(json.dumps(summary))
    except (ValueError, OSError, csv.Error, json.JSONDecodeError) as error:
        parser.exit(1, f'error: {error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
