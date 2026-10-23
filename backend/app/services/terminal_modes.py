"""Retain paste mode independently of the bounded terminal history.

Only parse terminal control sequences, never prompt text. OSC/DCS payloads are
opaque, partial sequences are bounded, and every feed can end mid-sequence.
"""
from __future__ import annotations

import re

_CONTROL = re.compile(r"[\x1b\x90\x98\x9b\x9d\x9e\x9f]")
_STRING_END = re.compile(r"[\x1b\x9c\x18\x1a\x07]")


class TerminalModes:
    def __init__(self) -> None:
        self.bracketed_paste = False
        self._state = "text"
        self._pending = ""
        self._osc = False

    def feed(self, data: str) -> None:
        offset = 0
        while offset < len(data):
            if self._state == "text":
                match = _CONTROL.search(data, offset)
                if not match:
                    return
                char = match[0]
                offset = match.end()
                if char == "\x1b":
                    self._state = "escape"
                elif char == "\x9b":
                    self._state, self._pending = "csi", ""
                else:
                    self._state, self._osc = "string", char == "\x9d"
                continue
            if self._state == "string":
                match = _STRING_END.search(data, offset)
                if not match:
                    return
                offset = match.end()
                if match[0] == "\x1b":
                    self._state = "string-escape"
                elif match[0] != "\x07" or self._osc:
                    self._state = "text"
                continue
            char = data[offset]
            offset += 1
            if self._state == "escape":
                if char == "[":
                    self._state, self._pending = "csi", ""
                elif char in "]PX^_":
                    self._state, self._osc = "string", char == "]"
                elif char != "\x1b":
                    if char == "c":  # RIS resets xterm's paste mode too.
                        self.bracketed_paste = False
                    self._state = "text"
            elif self._state == "string-escape":
                if char in "\\\x9c\x18\x1a" or (self._osc and char == "\x07"):
                    self._state = "text"
                elif char != "\x1b":
                    self._state = "string"
            else:  # CSI, or an overlong CSI being discarded until its final.
                if char in "\x18\x1a\x1b":
                    self._state = "escape" if char == "\x1b" else "text"
                    self._pending = ""
                    continue
                if "@" <= char <= "~":
                    if self._state == "csi" and char in "hl" and re.fullmatch(r"\?[0-9;]+", self._pending):
                        if any(value and int(value) == 2004 for value in self._pending[1:].split(";")):
                            self.bracketed_paste = char == "h"
                    self._state, self._pending = "text", ""
                elif self._state == "csi":
                    self._pending += char
                    if len(self._pending) > 128:
                        self._state, self._pending = "csi-pass", ""
