"""URL safety helpers for outbound fetches.

Image extraction fetches a client-supplied ``post_url`` and then follows image
references found in the response. Without validation, an attacker-controlled
``post_url`` turns the backend into a request proxy: it will happily GET
``http://169.254.169.254/latest/meta-data/`` and return the response body, or
reach hosts on the private network that the public internet cannot address.

Everything here is allowlist-first: an explicit set of permitted schemes and
host suffixes, plus a hard block on private, loopback, link-local and reserved
address space.
"""

import ipaddress
import socket
from typing import Iterable, Set
from urllib.parse import urlparse, urlunparse

ALLOWED_SCHEMES: Set[str] = {"http", "https"}

# Permitted host suffixes. A host is accepted when its registrable domain
# matches one of these.
ALLOWED_HOST_SUFFIXES: tuple[str, ...] = (
    "instagram.com",
    "cdninstagram.com",
    "fbcdn.net",
)

# Ports we are willing to connect to. Anything else is refused so the service
# cannot be used to scan arbitrary ports on reachable hosts.
ALLOWED_PORTS: Set[int] = {80, 443}

# Refuse URLs longer than this outright.
MAX_URL_LENGTH = 2048


class UnsafeUrlError(ValueError):
    """The URL is not permitted for outbound fetching."""


def _registrable_domain(host: str) -> str:
    """Return the registrable domain for a hostname.

    Handles the common two-label public suffixes so that a lookalike such as
    ``instagram.com.evil.net`` is not treated as a subdomain of Instagram, and
    ``notinstagram.com`` is not treated as Instagram either.
    """
    host = host.lower().rstrip(".")
    labels = host.split(".")
    if len(labels) <= 2:
        return host

    # Two-label public suffixes under which registrations happen directly.
    two_label_suffixes = {
        "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au",
        "co.nz", "co.za", "com.br", "co.in", "com.mx", "com.sg",
    }
    if ".".join(labels[-2:]) in two_label_suffixes:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _host_matches_allowlist(host: str, suffixes: Iterable[str]) -> bool:
    host = host.lower().rstrip(".")
    if not host:
        return False
    for suffix in suffixes:
        suffix = suffix.lower()
        if host == suffix:
            return True
        if host.endswith("." + suffix):
            return True
        # Compare on the registrable domain so that "notinstagram.com", whose
            # registrable domain is itself, does not match "instagram.com",
        # while "cdninstagram.com" does.
        if _registrable_domain(host) == suffix:
            return True
    return False


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        # IPv4-mapped IPv6 addresses such as ::ffff:127.0.0.1 bypass naive
        # checks if only the v4 properties are inspected.
        or getattr(ip, "ipv4_mapped", None) is not None
        and _is_blocked_ip(ip.ipv4_mapped)
    )


def _hostname_is_blocked(host: str) -> bool:
    """True when the hostname resolves entirely to blocked address space.

    A name that resolves to both a public and a private address is refused: the
    private answer is enough to reach an internal target, and DNS rebinding
    means the answer can change between this check and the request.
    """
    try:
        addr_infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        # Unresolvable now; let the HTTP client surface the failure.
        return False

    if not addr_infos:
        return False

    for info in addr_infos:
        sockaddr = info[4]
        raw_ip = sockaddr[0] if sockaddr else None
        if not raw_ip:
            continue
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError:
            continue
        if _is_blocked_ip(ip):
            return True
    return False


def validate_url(
    url: str,
    *,
    allowed_hosts: Iterable[str] = ALLOWED_HOST_SUFFIXES,
    allowed_schemes: Iterable[str] = ALLOWED_SCHEMES,
    check_dns: bool = True,
) -> str:
    """Validate ``url`` for outbound fetching, returning it normalized.

    Raises :class:`UnsafeUrlError` describing the first rule that failed.
    """
    if not url or not isinstance(url, str):
        raise UnsafeUrlError("URL must be a non-empty string")

    if len(url) > MAX_URL_LENGTH:
        raise UnsafeUrlError(f"URL exceeds {MAX_URL_LENGTH} characters")

    parsed = urlparse(url.strip())

    if parsed.scheme.lower() not in {s.lower() for s in allowed_schemes}:
        raise UnsafeUrlError(
            f"scheme {parsed.scheme!r} is not allowed "
            f"(allowed: {', '.join(sorted(allowed_schemes))})"
        )

    if not parsed.hostname:
        raise UnsafeUrlError("URL has no host")

    try:
        port = parsed.port
    except ValueError as exc:
        raise UnsafeUrlError("URL has an invalid port") from exc

    if port is not None and port not in ALLOWED_PORTS:
        raise UnsafeUrlError(f"port {port} is not allowed")

    host = parsed.hostname.lower()

    # A bare IP literal is never on the allowlist, but check address space
    # explicitly so the reason is accurate rather than a generic host failure.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if _is_blocked_ip(ipaddress.ip_address(host)):
            raise UnsafeUrlError(f"host {host} is in blocked address space")
        raise UnsafeUrlError(f"bare IP address {host} is not allowed")

    if not _host_matches_allowlist(host, allowed_hosts):
        raise UnsafeUrlError(
            f"host {host} is not in the allowlist "
            f"(allowed: {', '.join(sorted(allowed_hosts))})"
        )

    if check_dns and _hostname_is_blocked(host):
        raise UnsafeUrlError(
            f"host {host} resolves to blocked private or reserved address space"
        )

    return urlunparse(parsed._replace(fragment=""))
