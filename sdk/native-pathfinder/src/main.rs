#[cfg(test)]
mod tests;
mod world;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::error::Error;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UnixListener;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{mpsc, oneshot, Semaphore};
use world::World;

type AppError = Box<dyn Error>;
type Reply = Response<Full<Bytes>>;
type Sender = mpsc::Sender<Job>;

struct Job {
    body: Bytes,
    reply: oneshot::Sender<Reply>,
}

fn json_response(status: StatusCode, value: Value) -> Reply {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(value.to_string())))
        .expect("constant HTTP response headers")
}

fn invalid_query() -> Reply {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({"error":"Invalid pathfinding query"}),
    )
}
fn unavailable() -> Reply {
    json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"Pathfinding service is unavailable"}),
    )
}

async fn start_solver(path: PathBuf) -> Result<Sender, AppError> {
    let (sender, mut jobs) = mpsc::channel::<Job>(64);
    let (ready, initialized) = oneshot::channel();
    // The upstream crate has one mutable collision map and one BFS workspace.
    // Only this thread accesses them, including temporarily closed doors.
    std::thread::Builder::new()
        .name("pathfinding".into())
        .spawn(move || {
            let world = match World::open(&path) {
                Ok(world) => world,
                Err(error) => {
                    let _ = ready.send(Err(format!("could not load {}: {error}", path.display())));
                    return;
                }
            };
            if ready.send(Ok(())).is_err() {
                return;
            }
            while let Some(job) = jobs.blocking_recv() {
                if job.reply.is_closed() {
                    continue;
                }
                let result = std::panic::catch_unwind(|| {
                    let query: Value = serde_json::from_slice(&job.body).ok()?;
                    world.execute(&query)
                });
                let reply = match result {
                    Ok(Some(value)) => json_response(StatusCode::OK, value),
                    Ok(None) => invalid_query(),
                    Err(_) => json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        json!({"error":"Pathfinding query failed"}),
                    ),
                };
                let _ = job.reply.send(reply);
            }
        })?;
    initialized.await??;
    Ok(sender)
}

async fn handle(req: Request<Incoming>, jobs: Sender) -> Result<Reply, Infallible> {
    let reply = match (req.method(), req.uri().path()) {
        (&Method::GET, "/health") => json_response(StatusCode::OK, json!({"status":"ok"})),
        (&Method::POST, "/query") => {
            // Match Bun.serve's 128 MiB body ceiling. Normal requests are a few hundred bytes.
            let body = match Limited::new(req.into_body(), 128 * 1024 * 1024)
                .collect()
                .await
            {
                Ok(body) => body.to_bytes(),
                Err(error) if error.is::<http_body_util::LengthLimitError>() => {
                    return Ok(json_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        json!({"error":"Request body too large"}),
                    ));
                }
                Err(_) => return Ok(invalid_query()),
            };
            let (reply, result) = oneshot::channel();
            if jobs.send(Job { body, reply }).await.is_err() {
                unavailable()
            } else {
                result.await.unwrap_or_else(|_| unavailable())
            }
        }
        (_, "/query") => {
            let mut response = json_response(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"error":"Method not allowed"}),
            );
            response
                .headers_mut()
                .insert(header::ALLOW, header::HeaderValue::from_static("POST"));
            response
        }
        _ => json_response(
            StatusCode::NOT_FOUND,
            json!({"error":"Unknown pathfinding endpoint"}),
        ),
    };
    Ok(reply)
}

// Do not unlink a successor's socket when an old process exits.
struct BoundSocket {
    path: PathBuf,
    inode: (u64, u64),
}
impl BoundSocket {
    fn identify(path: &Path) -> io::Result<Self> {
        let meta = fs::symlink_metadata(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            inode: (meta.dev(), meta.ino()),
        })
    }
}
impl Drop for BoundSocket {
    fn drop(&mut self) {
        if let Ok(meta) = fs::symlink_metadata(&self.path) {
            if (meta.dev(), meta.ino()) == self.inode {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn follow_supervisor() -> Result<(), AppError> {
    if let Some(expected) = std::env::var_os("RS_PATHFINDING_PARENT_PID") {
        let pid: libc::pid_t = expected.to_str().ok_or("invalid supervisor pid")?.parse()?;
        // Register before comparing. A parent that died before registration will
        // already have been replaced; a later death delivers SIGTERM.
        unsafe {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error().into());
            }
            if libc::getppid() != pid {
                return Err("pathfinding supervisor exited".into());
            }
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), AppError> {
    let mut args = std::env::args_os().skip(1);
    let socket = PathBuf::from(
        args.next()
            .ok_or("expected pathfinder-native SOCKET COLLISION_JSON")?,
    );
    if socket == Path::new("--source-tree") {
        println!(
            "{}",
            option_env!("RS_PATHFINDER_SOURCE_TREE").unwrap_or("development")
        );
        return Ok(());
    }
    let map = args
        .next()
        .ok_or("expected original SDK collision-data.json path")?;
    if args.next().is_some() {
        return Err("expected pathfinder-native SOCKET COLLISION_JSON".into());
    }
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    #[cfg(target_os = "linux")]
    follow_supervisor()?;
    let jobs = tokio::select! {
        ready = start_solver(PathBuf::from(map)) => ready?,
        _ = term.recv() => return Ok(()),
        _ = interrupt.recv() => return Ok(()),
    };
    let listener = UnixListener::bind(&socket)?;
    let _socket_guard = BoundSocket::identify(&socket)?;
    let connections = Arc::new(Semaphore::new(256));
    eprintln!("[pathfinding] native service ready");
    loop {
        let permit = tokio::select! {
            permit = connections.clone().acquire_owned() => permit?,
            _ = term.recv() => break,
            _ = interrupt.recv() => break,
        };
        let (stream, _) = tokio::select! {
            client = listener.accept() => client?,
            _ = term.recv() => break,
            _ = interrupt.recv() => break,
        };
        let sender = jobs.clone();
        tokio::spawn(async move {
            let _permit = permit;
            serve(stream, sender).await;
        });
    }
    Ok(())
}

async fn serve<T>(stream: T, jobs: Sender)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let service = service_fn(move |req| handle(req, jobs.clone()));
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(30))
        .serve_connection(TokioIo::new(stream), service)
        .await;
}
