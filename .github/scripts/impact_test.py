# SPDX-License-Identifier: MIT
"""Tests for impact.py's decisions (no Git needed):
python3 -m unittest discover -s .github/scripts -p 'impact_test.py'"""

import unittest

from impact import Changes, acknowledgements, evaluate, glob_re, map_problems

RULES = [
    {"id": "pair", "why": "w", "files": ["a/one.ts", "b/two.go"]},
    {"id": "copies", "why": "w", "when": ["docs/*.md"], "then": ["copies/*.md"], "checked": "a test"},
    {"id": "envs", "why": "w", "when": ["chart/values.yaml"], "then": ["env/kind.yaml", "env/gke.yaml"]},
]


def by_id(findings):
    return {f.rule: f for f in findings}


class GlobTest(unittest.TestCase):
    def test_star_stays_in_a_folder_and_double_star_crosses(self):
        self.assertTrue(glob_re("docs/*.md").match("docs/a.md"))
        self.assertFalse(glob_re("docs/*.md").match("docs/clouds/a.md"))
        self.assertTrue(glob_re("proto/**/*.proto").match("proto/vennir/v1/x.proto"))
        self.assertTrue(glob_re("proto/**/*.proto").match("proto/x.proto"))
        self.assertTrue(glob_re("gen/**").match("gen/a/b.ts"))
        self.assertFalse(glob_re("a/one.ts").match("a/one.tsx"))
        self.assertFalse(glob_re("a.ts").match("xa.ts"))


class EvaluateTest(unittest.TestCase):
    def test_one_side_of_a_pair_fails_until_the_other_changes_or_is_acknowledged(self):
        only_one = by_id(evaluate(RULES, [], Changes({"a/one.ts": "M"}), {}))
        self.assertTrue(only_one["pair"].fails)
        self.assertEqual(only_one["pair"].missing, ["b/two.go"])

        both = by_id(evaluate(RULES, [], Changes({"a/one.ts": "M", "b/two.go": "M"}), {}))
        self.assertFalse(both["pair"].fails)

        acked = by_id(evaluate(RULES, [], Changes({"b/two.go": "M"}), {"pair": "only a log line"}))
        self.assertFalse(acked["pair"].fails)
        self.assertEqual(acked["pair"].acknowledged, "only a log line")

    def test_untouched_rules_are_not_reported(self):
        self.assertEqual(evaluate(RULES, [], Changes({"elsewhere.ts": "M"}), {}), [])

    def test_a_checked_rule_is_reported_but_never_fails(self):
        found = by_id(evaluate(RULES, [], Changes({"docs/x.md": "M"}), {}))
        self.assertEqual(found["copies"].missing, ["copies/*.md"])
        self.assertFalse(found["copies"].fails)

    def test_when_then_runs_one_way_and_names_each_missing_file(self):
        found = by_id(evaluate(RULES, [], Changes({"chart/values.yaml": "M", "env/kind.yaml": "M"}), {}))
        self.assertEqual(found["envs"].missing, ["env/gke.yaml"])
        self.assertNotIn("envs", by_id(evaluate(RULES, [], Changes({"env/gke.yaml": "M"}), {})))

    def test_added_or_removed_files_need_the_repository_map(self):
        added = by_id(evaluate([], ["gen/**"], Changes({"src/new.ts": "A", "gen/x.ts": "A", "src/old.ts": "M"}), {}))
        self.assertEqual(added["repository-map"].changed, ["src/new.ts"])
        self.assertTrue(added["repository-map"].fails)
        mapped = by_id(evaluate([], [], Changes({"src/new.ts": "A", "docs/repository-map.md": "M"}), {}))
        self.assertFalse(mapped["repository-map"].fails)
        only_generated = evaluate([], ["gen/**"], Changes({"gen/x.ts": "D"}), {})
        self.assertEqual(only_generated, [])


class TrailerTest(unittest.TestCase):
    def test_reads_impact_checked_trailers_case_insensitively(self):
        messages = "fix: x\n\nImpact-checked: pair: comment only\nimpact-checked: Envs: kind only\nImpact-checked: missing-reason:\n"
        self.assertEqual(acknowledgements(messages), {"pair": "comment only", "envs": "kind only"})


class MapTest(unittest.TestCase):
    def test_a_path_that_matches_nothing_or_a_malformed_rule_is_a_problem(self):
        tracked = {"a/one.ts", "b/two.go", "docs/x.md", "copies/x.md", "chart/values.yaml", "env/kind.yaml", "env/gke.yaml"}
        self.assertEqual(map_problems(RULES, tracked), [])
        problems = map_problems(RULES + [
            {"id": "pair", "why": "w", "files": ["a/one.ts", "b/gone.go"]},
            {"id": "both", "why": "w", "files": ["a/one.ts", "b/two.go"], "when": ["x"], "then": ["y"]},
            {"id": "lonely", "why": "w", "files": ["a/one.ts"]},
        ], tracked)
        self.assertIn("pair: the id is used twice", problems)
        self.assertIn("pair: b/gone.go matches no file (moved or renamed? update .github/impact.toml)", problems)
        self.assertIn("both: give either files, or when and then", problems)
        self.assertIn("lonely: files needs at least two entries", problems)


if __name__ == "__main__":
    unittest.main()
