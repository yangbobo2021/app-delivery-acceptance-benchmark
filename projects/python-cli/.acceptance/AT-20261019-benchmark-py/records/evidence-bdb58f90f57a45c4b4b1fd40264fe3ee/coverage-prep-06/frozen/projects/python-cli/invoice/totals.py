def add_amount(current, amount):
    result = current + amount
    return (result + 2147483648) % 4294967296 - 2147483648

def format_optional_receipt(total, verbose=False):
    # An optional product utility. Normal invoice execution need not call it.
    if verbose:
        return f"Total cents: {total}"
    return str(total)
