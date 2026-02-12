#!/usr/bin/env python3
"""IssuePilot: local, rule-based GitHub issue triage CLI

A lightweight MVP that classifies issues into categories and labels
based on a JSON rules file. No external dependencies required.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Set

DEFAULT_RULES_PATH = Path(__file__).parent / "triage_rules.json"


def load_json(path: Path) -> List[Dict]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


class RuleSet:
    def __init__(self, rules: Dict):
        # rules: {"patterns": [{"label": str, "keywords": [str]}],
        #         "priority_keywords": {"high": [str], ...},
        #         "default_labels": [str]}
        self.patterns = rules.get("patterns", [])
        self.priority = rules.get("priority_keywords", {})
        self.default_labels = rules.get("default_labels", [])

    def match_labels(self, text: str) -> Set[str]:
        t = normalize_text(text)
        found: Set[str] = set(self.default_labels)
        for p in self.patterns:
            label = p.get("label")
            keywords = p.get("keywords", [])
            for kw in keywords:
                if kw and kw.lower() in t:
                    found.add(label)
                    break
        return found

    def guess_priority(self, text: str) -> str:
        t = normalize_text(text)
        # High priority if any high-priority keyword present
        for pri, words in self.priority.items():
            for w in words:
                if w and w.lower() in t:
                    return pri
        return "low"


def triage_issue(issue: Dict, rules: RuleSet) -> Dict:
    # Combine title and body for analysis
    title = issue.get("title", "") or ""
    body = issue.get("body", "") or ""
    text = f"{title} {body}"
    labels = rules.match_labels(text)
    priority = rules.guess_priority(text)
    category = "other"
    # Simple category hint based on label intent if present
    if any(l in ("bug", "error", "crash") for l in labels):
        category = "bug"
    elif any(l in ("enhancement", "feature") for l in labels):
        category = "feature"
    elif any(l in ("question", "docs", "help") for l in labels):
        category = "question"
    # Build result
    return {
        "id": issue.get("id"),
        "title": title,
        "labels": sorted(list(labels)),
        "category": category,
        "priority": priority,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        prog="issue-pilot", description="Rule-based GitHub issue triage (MVP)"
    )
    parser.add_argument(
        "--input", required=False, help="Path to input issues JSON (array of issues)"
    )
    parser.add_argument("--rules", required=False, help="Path to triage rules JSON")
    parser.add_argument("--output", required=False, help="Path to output JSON results")
    args = parser.parse_args()

    input_path: Path
    if args.input:
        input_path = Path(args.input)
    else:
        input_path = Path("demo/issues.json")

    rules_path = Path(args.rules) if args.rules else DEFAULT_RULES_PATH
    output_path = Path(args.output) if args.output else Path("triaged_issues.json")

    rules = RuleSet(load_json(rules_path))
    issues = load_json(input_path)
    results = [triage_issue(issue, rules) for issue in issues]
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(results)} triaged issues to {output_path}")


if __name__ == "__main__":
    main()
