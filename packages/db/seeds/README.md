# Domain trust bootstrap data

Migration `0005_seed_domain_trust.sql` provides conservative initial scores for
primary public institutions and widely used wire/public broadcasters. It is a
bootstrap, not a permanent media-reliability ranking.

The `domains` table is deliberately operator-maintained: revise a score with a
documented source and review date, and use Tracera's verified outcomes to
refine it over time. Do not treat a domain score as a verdict on an individual
article; it is only one input to evidence quality and source ranking.
