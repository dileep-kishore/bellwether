//! HTTP/1.1 to `127.0.0.1` only, for Chrome's DevTools endpoints and port checks.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// The largest body any caller needs; `/json/list` with many tabs stays far below it.
const MAX_BODY: usize = 1024 * 1024;
const MAX_HEAD: usize = 64 * 1024;

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

pub fn get(port: u16, path: &str, timeout: Duration) -> io::Result<Reply> {
    request("GET", port, path, timeout)
}

/// Chrome's `/json/new` refuses GET, so new tabs go through here.
pub fn put(port: u16, path: &str, timeout: Duration) -> io::Result<Reply> {
    request("PUT", port, path, timeout)
}

fn request(method: &str, port: u16, path: &str, timeout: Duration) -> io::Result<Reply> {
    // A space or line break in the path would let a caller's URL write its own request line or headers.
    if !path.starts_with('/') || path.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!("bad request path {path:?}"),
        ));
    }
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_write_timeout(Some(remaining(deadline)?))?;
    let body_header = if method == "PUT" {
        "Content-Length: 0\r\n"
    } else {
        ""
    };
    stream.write_all(
        format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{body_header}\r\n"
        )
        .as_bytes(),
    )?;
    let mut reader = Reader {
        stream,
        deadline,
        buf: Vec::new(),
        pos: 0,
        eof: false,
    };
    read_reply(&mut reader)
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err(io::Error::new(ErrorKind::TimedOut, "timed out"))
    } else {
        Ok(left)
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message.into())
}

/// Buffered reads that share one deadline, so a server that sends a byte at a time still times out.
struct Reader {
    stream: TcpStream,
    deadline: Instant,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
}

impl Reader {
    /// Reads more bytes; false once the server has closed.
    fn fill(&mut self) -> io::Result<bool> {
        if self.eof {
            return Ok(false);
        }
        self.stream
            .set_read_timeout(Some(remaining(self.deadline)?))?;
        let mut chunk = [0u8; 16 * 1024];
        let n = match self.stream.read(&mut chunk) {
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                return Err(io::Error::new(ErrorKind::TimedOut, "timed out"))
            }
            Err(e) => return Err(e),
        };
        if n == 0 {
            self.eof = true;
            return Ok(false);
        }
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(true)
    }

    fn pending(&self) -> &[u8] {
        &self.buf[self.pos..]
    }

    /// One line without its CRLF, from at most `limit` bytes.
    fn line(&mut self, limit: usize) -> io::Result<Vec<u8>> {
        loop {
            if let Some(i) = self.pending().windows(2).position(|w| w == b"\r\n") {
                let line = self.pending()[..i].to_vec();
                self.pos += i + 2;
                return Ok(line);
            }
            if self.pending().len() > limit {
                return Err(invalid("reply line too long"));
            }
            if !self.fill()? {
                return Err(invalid("reply ended early"));
            }
        }
    }

    fn exact(&mut self, n: usize, out: &mut Vec<u8>) -> io::Result<()> {
        while self.pending().len() < n {
            if !self.fill()? {
                return Err(invalid("reply ended early"));
            }
        }
        out.extend_from_slice(&self.pending()[..n]);
        self.pos += n;
        Ok(())
    }

    fn until_close(&mut self, out: &mut Vec<u8>) -> io::Result<()> {
        loop {
            out.extend_from_slice(self.pending());
            self.pos = self.buf.len();
            if out.len() > MAX_BODY {
                return Err(too_big());
            }
            if !self.fill()? {
                return Ok(());
            }
        }
    }
}

fn too_big() -> io::Error {
    invalid("reply body is over 1 MiB")
}

fn read_reply(r: &mut Reader) -> io::Result<Reply> {
    let status_line = r.line(MAX_HEAD)?;
    let status = parse_status(&status_line)?;
    let mut length = None;
    let mut chunked = false;
    let mut head_bytes = status_line.len();
    loop {
        let line = r.line(MAX_HEAD)?;
        head_bytes += line.len() + 2;
        if head_bytes > MAX_HEAD {
            return Err(invalid("reply headers too long"));
        }
        if line.is_empty() {
            break;
        }
        let line = String::from_utf8_lossy(&line);
        let Some((name, value)) = line.split_once(':') else {
            return Err(invalid(format!("bad header {line:?}")));
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let n: usize = value
                .parse()
                .map_err(|_| invalid(format!("bad Content-Length {value:?}")))?;
            length = Some(n);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|v| v.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    let mut body = Vec::new();
    if chunked {
        read_chunks(r, &mut body)?;
    } else if let Some(n) = length {
        if n > MAX_BODY {
            return Err(too_big());
        }
        r.exact(n, &mut body)?;
    } else {
        r.until_close(&mut body)?;
    }
    Ok(Reply { status, body })
}

fn parse_status(line: &[u8]) -> io::Result<u16> {
    let line = String::from_utf8_lossy(line);
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let code = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") || code.len() != 3 {
        return Err(invalid(format!("not an HTTP reply: {line:?}")));
    }
    code.parse()
        .map_err(|_| invalid(format!("not an HTTP reply: {line:?}")))
}

fn read_chunks(r: &mut Reader, body: &mut Vec<u8>) -> io::Result<()> {
    loop {
        let line = r.line(1024)?;
        let line = String::from_utf8_lossy(&line);
        let size = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size, 16)
            .map_err(|_| invalid(format!("bad chunk size {size:?}")))?;
        if size == 0 {
            // Trailers end at an empty line; their contents are not needed.
            while !r.line(MAX_HEAD)?.is_empty() {}
            return Ok(());
        }
        if body.len() + size > MAX_BODY {
            return Err(too_big());
        }
        r.exact(size, body)?;
        if !r.line(2)?.is_empty() {
            return Err(invalid("chunk without its CRLF"));
        }
    }
}
