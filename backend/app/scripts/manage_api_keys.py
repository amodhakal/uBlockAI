"""Manage API keys.

    python -m app.scripts.manage_api_keys mint --label "laptop"
    python -m app.scripts.manage_api_keys list
    python -m app.scripts.manage_api_keys revoke --id k_abc123

``mint`` prints the key once. Only its SHA-256 is stored, so a lost key cannot
be recovered and must be replaced.
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from app.auth import generate_key, load_registry, register_key, revoke_key


def cmd_mint(args: argparse.Namespace) -> int:
    raw = generate_key()
    key_id = register_key(raw, args.label)
    print(f"key id:    {key_id}")
    print(f"api key:   {raw}")
    print()
    print("This is the only time the key is shown. It is not recoverable;")
    print("only its SHA-256 is stored. If you lose it, mint a new one.")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    keys = load_registry()
    if not keys:
        print("no keys registered")
        return 0
    print(f"{'id':<20} {'label':<24} {'status':<10} created")
    for key in keys:
        status = "disabled" if key.get("disabled") else "active"
        print(
            f"{key.get('id', ''):<20} {key.get('label', ''):<24} {status:<10} {key.get('created_at', '')}"
        )
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    if revoke_key(args.id):
        print(f"revoked {args.id}")
        return 0
    print(f"no such key: {args.id}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage uBlockAI API keys.")
    sub = parser.add_subparsers(dest="command", required=True)

    mint = sub.add_parser("mint", help="Create a new key")
    mint.add_argument("--label", default="", help="Human-readable note")
    mint.set_defaults(func=cmd_mint)

    listing = sub.add_parser("list", help="List registered keys")
    listing.set_defaults(func=cmd_list)

    revoke = sub.add_parser("revoke", help="Delete a key")
    revoke.add_argument("--id", required=True)
    revoke.set_defaults(func=cmd_revoke)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
