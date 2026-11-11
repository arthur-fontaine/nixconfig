"""The text-level echo filter: is what the mic heard just Pi's own voice coming back?

macOS voice processing subtracts the speaker signal from the mic, but leaves a
tail. Soniox v6's idea, done locally: the daemon knows the text it is saying,
so a transcript heard while (or just after) it spoke that mostly consists of
the same words, in order, is the echo.
"""

import re
from difflib import SequenceMatcher


def words(text: str) -> list[str]:
    return re.sub(r"[^\w' ]+", " ", text.lower().replace("’", "'")).split()


def is_echo(heard: str, spoken: str, threshold: float = 0.6) -> bool:
    """True when most of `heard` appears, in order, in `spoken` (the recent speech of Pi)."""
    h, s = words(heard), words(spoken)
    if not h or not s:
        return False
    matched = sum(b.size for b in SequenceMatcher(None, h, s, autojunk=False).get_matching_blocks())
    return matched / len(h) >= threshold
