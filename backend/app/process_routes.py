"""Give every processed spare without a route its standard manufacturing route (see app.services.process).

    python -m app.process_routes            # only items that have no route yet
    python -m app.process_routes --reset    # re-apply the standard route to every processed spare
"""
from __future__ import annotations

import argparse
from collections import Counter

from sqlalchemy import select

from .db import SessionLocal
from .models import Item, ItemType, ProcessStep, User
from .services.process import apply_standard


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="overwrite existing routes with the standard one")
    args = parser.parse_args()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "admin"))
        routed = set(db.scalars(select(ProcessStep.item_id).distinct()))
        families: Counter[str] = Counter()
        for item in db.scalars(select(Item).where(Item.item_type == ItemType.PROCESSED_SPARE, Item.is_active.is_(True))):
            if item.id in routed and not args.reset:
                continue
            key, _ = apply_standard(db, user, item)
            families[key] += 1
        db.commit()
        print({"routed": sum(families.values()), "by_route": dict(families)})


if __name__ == "__main__":
    main()
