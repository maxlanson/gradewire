// Toy coding tasks with hermetic tests (no clock, randomness, I/O or ordering dependence),
// plus pre-generated "rollouts": model attempts at each task, some correct, some buggy.
// The trainer replays these instead of running a live model.

const TASKS = {
  add: {
    tests: `from solution import add\n\ndef test_basic():\n    assert add(2, 3) == 5\n\ndef test_negative():\n    assert add(-4, 1) == -3\n\ndef test_zero():\n    assert add(0, 0) == 0\n`,
    good: `def add(a, b):\n    return a + b\n`,
    bad: `def add(a, b):\n    return abs(a) + abs(b)\n`,
  },
  reverse_words: {
    tests: `from solution import reverse_words\n\ndef test_two():\n    assert reverse_words("hello world") == "world hello"\n\ndef test_one():\n    assert reverse_words("solo") == "solo"\n\ndef test_spaces():\n    assert reverse_words("  a  b ") == "b a"\n`,
    good: `def reverse_words(s):\n    return " ".join(reversed(s.split()))\n`,
    bad: `def reverse_words(s):\n    return " ".join(reversed(s.split(" ")))\n`,
  },
  is_palindrome: {
    tests: `from solution import is_palindrome\n\ndef test_yes():\n    assert is_palindrome("racecar")\n\ndef test_no():\n    assert not is_palindrome("rocket")\n\ndef test_case_and_spaces():\n    assert is_palindrome("A man a plan a canal Panama")\n`,
    good: `def is_palindrome(s):\n    t = "".join(c.lower() for c in s if c.isalnum())\n    return t == t[::-1]\n`,
    bad: `def is_palindrome(s):\n    return s == s[::-1]\n`,
  },
  fizzbuzz: {
    tests: `from solution import fizzbuzz\n\ndef test_three():\n    assert fizzbuzz(9) == "Fizz"\n\ndef test_five():\n    assert fizzbuzz(10) == "Buzz"\n\ndef test_fifteen():\n    assert fizzbuzz(30) == "FizzBuzz"\n\ndef test_plain():\n    assert fizzbuzz(7) == "7"\n`,
    good: `def fizzbuzz(n):\n    if n % 15 == 0:\n        return "FizzBuzz"\n    if n % 3 == 0:\n        return "Fizz"\n    if n % 5 == 0:\n        return "Buzz"\n    return str(n)\n`,
    bad: `def fizzbuzz(n):\n    if n % 3 == 0:\n        return "Fizz"\n    if n % 5 == 0:\n        return "Buzz"\n    return str(n)\n`,
  },
  max_subarray: {
    tests: `from solution import max_subarray\n\ndef test_mixed():\n    assert max_subarray([-2, 1, -3, 4, -1, 2, 1, -5, 4]) == 6\n\ndef test_all_negative():\n    assert max_subarray([-3, -1, -2]) == -1\n\ndef test_single():\n    assert max_subarray([5]) == 5\n`,
    good: `def max_subarray(xs):\n    best = cur = xs[0]\n    for x in xs[1:]:\n        cur = max(x, cur + x)\n        best = max(best, cur)\n    return best\n`,
    bad: `def max_subarray(xs):\n    best = cur = 0\n    for x in xs:\n        cur = max(0, cur + x)\n        best = max(best, cur)\n    return best\n`,
  },
  gcd: {
    tests: `from solution import gcd\n\ndef test_basic():\n    assert gcd(12, 18) == 6\n\ndef test_coprime():\n    assert gcd(17, 5) == 1\n\ndef test_zero():\n    assert gcd(0, 9) == 9\n`,
    good: `def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n`,
    bad: `def gcd(a, b):\n    return min(a, b) if max(a, b) % min(a, b or 1) == 0 else 1\n`,
  },
  flatten: {
    tests: `from solution import flatten\n\ndef test_nested():\n    assert flatten([1, [2, [3, [4]]], 5]) == [1, 2, 3, 4, 5]\n\ndef test_empty():\n    assert flatten([]) == []\n\ndef test_flat():\n    assert flatten([1, 2]) == [1, 2]\n`,
    good: `def flatten(xs):\n    out = []\n    for x in xs:\n        out.extend(flatten(x) if isinstance(x, list) else [x])\n    return out\n`,
    bad: `def flatten(xs):\n    out = []\n    for x in xs:\n        out.extend(x if isinstance(x, list) else [x])\n    return out\n`,
  },
  roman: {
    tests: `from solution import to_roman\n\ndef test_small():\n    assert to_roman(3) == "III"\n\ndef test_subtractive():\n    assert to_roman(9) == "IX"\n\ndef test_year():\n    assert to_roman(1994) == "MCMXCIV"\n`,
    good: `def to_roman(n):\n    vals = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),\n            (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]\n    out = ""\n    for v, s in vals:\n        while n >= v:\n            out += s\n            n -= v\n    return out\n`,
    bad: `def to_roman(n):\n    vals = [(1000, "M"), (500, "D"), (100, "C"), (50, "L"), (10, "X"), (5, "V"), (1, "I")]\n    out = ""\n    for v, s in vals:\n        while n >= v:\n            out += s\n            n -= v\n    return out\n`,
  },
  dedupe: {
    tests: `from solution import dedupe\n\ndef test_order_kept():\n    assert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]\n\ndef test_empty():\n    assert dedupe([]) == []\n`,
    good: `def dedupe(xs):\n    seen = set()\n    return [x for x in xs if not (x in seen or seen.add(x))]\n`,
    bad: `def dedupe(xs):\n    return sorted(set(xs))\n`,
  },
  binary_search: {
    tests: `from solution import binary_search\n\ndef test_found():\n    assert binary_search([1, 3, 5, 7, 9], 7) == 3\n\ndef test_missing():\n    assert binary_search([1, 3, 5], 4) == -1\n\ndef test_first():\n    assert binary_search([2, 4, 6], 2) == 0\n`,
    good: `def binary_search(xs, t):\n    lo, hi = 0, len(xs) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if xs[mid] == t:\n            return mid\n        if xs[mid] < t:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return -1\n`,
    // Infinite loop on a miss: exercises the timeout path.
    bad: `def binary_search(xs, t):\n    lo, hi = 0, len(xs) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if xs[mid] == t:\n            return mid\n        if xs[mid] < t:\n            lo = mid\n        else:\n            hi = mid\n    return -1\n`,
  },
};

export const ROLLOUTS = Object.entries(TASKS).flatMap(([task, t]) => ['good', 'bad'].map((variant) => ({
  id: `${task}-${variant}`,
  task,
  files: [
    { path: 'solution.py', content: t[variant] },
    { path: 'test_solution.py', content: t.tests },
  ],
})));
