import asyncio

from pi_voice import framing


def test_frames_round_trip():
    async def run():
        reader = asyncio.StreamReader()
        reader.feed_data(framing.frame(framing.MIC, b"\x01\x00" * 4))
        reader.feed_data(framing.json_frame(framing.EVENT, {"event": "played", "seq": 3}))
        reader.feed_data(framing.speaker_frame(7, framing.EARCON, b"\x02\x00"))
        reader.feed_eof()
        a = await framing.read_frame(reader)
        b = await framing.read_frame(reader)
        c = await framing.read_frame(reader)
        assert await framing.read_frame(reader) is None
        return a, b, c

    (k1, p1), (k2, p2), (k3, p3) = asyncio.run(run())
    assert (k1, p1) == (framing.MIC, b"\x01\x00" * 4)
    assert k2 == framing.EVENT and b'"seq": 3' in p2
    assert k3 == framing.SPEAKER and framing.parse_speaker(p3) == (7, framing.EARCON, b"\x02\x00")
