#!/usr/bin/env python3
"""Set GitHub Actions secrets for auto-deploy (NutsRiver).

Usage:
  GH_TOKEN=... python3 scripts/set-gh-secrets.py \
    --repo asaphase-sketch/nutsriver \
    --secret CLOUDFLARE_API_TOKEN=... \
    --secret CLOUDFLARE_ACCOUNT_ID=...

Encrypts each value with the repo's libsodium public key (sealed box),
then PUTs it to the Actions secrets API. Token stays in memory only.
"""
import argparse
import base64
import json
import sys
import urllib.request

from nacl import encoding, public


def api(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=json.dumps(payload).encode() if payload else None)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--secret", action="append", default=[], metavar="NAME=VALUE")
    args = ap.parse_args()
    token = __import__("os").environ["GH_TOKEN"]

    pk = api("GET", f"https://api.github.com/repos/{args.repo}/actions/secrets/public-key", token)
    key = public.PublicKey(pk["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(key)
    print(f"repo key: id={pk['key_id']}")

    for item in args.secret:
        name, _, value = item.partition("=")
        enc = sealed.encrypt(value.encode())
        api(
            "PUT",
            f"https://api.github.com/repos/{args.repo}/actions/secrets/{name}",
            token,
            {"encrypted_value": base64.b64encode(enc).decode(), "key_id": pk["key_id"]},
        )
        print(f"set secret {name} OK")
    print("done")


if __name__ == "__main__":
    sys.exit(main())
