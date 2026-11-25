//! The server names the webview may save or delete a sign-in under. The
//! credential store also holds entries the native side names itself
//! (`identity:<host>`, `pending-messages:<digest>`), so a sign-in is only
//! ever stored under a plain server address.

use std::fmt;
use std::net::Ipv6Addr;

/// The longest server address accepted, as for the proxies' `remote_host`.
const MAX_HOST_LEN: usize = 260;

/// Entry-name prefixes the native side uses for its own secrets.
const RESERVED_PREFIXES: [&str; 2] = ["identity:", "pending-messages:"];

/// Why a sign-in entry name was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialHostError {
    /// Empty or longer than the limit.
    Length,
    /// Starts with a prefix the native side keeps for its own entries.
    Reserved,
    /// Not `name[:port]`, `[ipv6][:port]` or a bare IPv6 address.
    Shape,
}

impl fmt::Display for CredentialHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Length => "host is empty or too long",
            Self::Reserved => "host is not a server address",
            Self::Shape => "host must be a server address with an optional port",
        })
    }
}

impl std::error::Error for CredentialHostError {}

/// Accept `host` as a sign-in entry name only when it has the shape of the
/// server addresses the connect page saves (`canonicalServerHost`: a typed
/// address with its scheme and path removed): a name or IPv4 address with an
/// optional port, a bracketed IPv6 address with an optional port, or a bare
/// IPv6 address.
pub fn validate_credential_host(host: &str) -> Result<(), CredentialHostError> {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return Err(CredentialHostError::Length);
    }
    if RESERVED_PREFIXES.iter().any(|p| host.starts_with(p)) {
        return Err(CredentialHostError::Reserved);
    }
    let shaped = if let Some(rest) = host.strip_prefix('[') {
        bracketed_shape(rest)
    } else if host.matches(':').count() > 1 {
        host.parse::<Ipv6Addr>().is_ok()
    } else {
        match host.split_once(':') {
            Some((name, port)) => is_name(name) && is_port(port),
            None => is_name(host),
        }
    };
    if shaped {
        Ok(())
    } else {
        Err(CredentialHostError::Shape)
    }
}

/// `rest` (after the `[`) is `<ipv6>]` or `<ipv6>]:<port>`.
fn bracketed_shape(rest: &str) -> bool {
    let Some((address, tail)) = rest.split_once(']') else {
        return false;
    };
    let port_ok = tail.is_empty() || tail.strip_prefix(':').is_some_and(is_port);
    port_ok && address.parse::<Ipv6Addr>().is_ok()
}

fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn is_port(port: &str) -> bool {
    !port.is_empty()
        && port.len() <= 5
        && port.chars().all(|c| c.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|p| p > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_accepted() {
        for host in [
            "chat.example.com",
            "chat.example.com:8443",
            "Chat.Example.com",
            "localhost",
            "localhost:8443",
            "127.0.0.1",
            "192.168.1.20:8443",
            "my_server:8443",
            "xn--bcher-kva.example",
            "[::1]",
            "[::1]:8443",
            "[2001:db8::7]:443",
            "::1",
            "2001:db8::7",
        ] {
            assert_eq!(validate_credential_host(host), Ok(()), "{host}");
        }
    }

    #[test]
    fn the_native_sides_own_entry_names_are_refused() {
        for host in [
            "identity:chat.example.com",
            "identity:1234",
            "identity::1",
            "pending-messages:0123456789abcdef",
            "pending-messages:1",
        ] {
            assert_eq!(
                validate_credential_host(host),
                Err(CredentialHostError::Reserved),
                "{host}"
            );
        }
    }

    #[test]
    fn other_shapes_are_refused() {
        for host in [
            "chat.example.com:",
            "chat.example.com:0",
            "chat.example.com:65536",
            "chat.example.com:84a3",
            "chat.example.com/path",
            "https://chat.example.com",
            "user@chat.example.com",
            "chat example.com",
            "chat.example.com\n",
            "[::1",
            "[::1]x",
            "[::1]:",
            "[not-v6]:8443",
            "a:b:c",
        ] {
            assert_eq!(
                validate_credential_host(host),
                Err(CredentialHostError::Shape),
                "{host}"
            );
        }
        assert_eq!(
            validate_credential_host(""),
            Err(CredentialHostError::Length)
        );
        assert_eq!(
            validate_credential_host(&"a".repeat(MAX_HOST_LEN + 1)),
            Err(CredentialHostError::Length)
        );
    }
}
