import unittest
from fib import fib

class TestFibonacciFunction(unittest.TestCase):
    def test_fibonacci_n1(self):
        self.assertEqual(fib(1), 0)
    def test_fibonacci_n2(self):
        self.assertEqual(fib(2), 1)
    def test_fibonacci_n10(self):
        self.assertEqual(fib(10), 34)

if __name__ == '__main__':
    unittest.main()