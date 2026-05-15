"""cold-stack booking — minimal Calendly substitute.

Operator declares free windows in state/availability.json. Booking CLI
proposes slots in the prospect's timezone, holds them, then confirms one
by sending a real .ics calendar invite over SMTP.
"""
