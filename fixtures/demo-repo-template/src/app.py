"""Tiny demo application (Underwatch disposable demo workspace)."""


def greet(name: str) -> str:
    """Return a friendly greeting."""
    name = name.strip() or "world"
    return f"Hello, {name}!"


def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


if __name__ == "__main__":
    print(greet("Underwatch"))
