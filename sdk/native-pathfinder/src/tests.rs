use super::*;
use hyper::client::conn::http1::{handshake, SendRequest};

async fn call(
    client: &mut SendRequest<Full<Bytes>>,
    method: Method,
    path: &str,
    body: Value,
) -> (StatusCode, hyper::HeaderMap, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", "pathfinding")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap();
    let response = client.send_request(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let json = serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap();
    (parts.status, parts.headers, json)
}

#[tokio::test]
async fn http_and_door_state() {
    let map = Path::new(env!("CARGO_MANIFEST_DIR")).join("../collision-data.json");
    let jobs = start_solver(map).await.unwrap();
    let (a, b) = tokio::io::duplex(65536);
    tokio::spawn(serve(a, jobs));
    let (mut client, conn) = handshake(TokioIo::new(b)).await.unwrap();
    tokio::spawn(conn);
    let (status, _, body) = call(&mut client, Method::GET, "/health", Value::Null).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"status":"ok"})));
    let (status, headers, _) = call(&mut client, Method::GET, "/query", Value::Null).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(headers[header::ALLOW], "POST");
    assert_eq!(
        call(
            &mut client,
            Method::POST,
            "/query",
            json!({"type":"tile","level":4,"x":1,"z":2})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&mut client, Method::GET, "/missing", Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // The Wizards' Tower diagonal door is open in the shared snapshot. A
    // single requesting bot can exclude it without changing the next route.
    let query = json!({"type":"route","level":0,"srcX":3109,"srcZ":3172,"destX":3106,"destZ":3161,"maxWaypoints":500});
    let (status, _, open) = call(&mut client, Method::POST, "/query", query.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let last = json!({"level":0,"x":3106,"z":3161});
    assert_eq!(open["waypoints"].as_array().unwrap().last(), Some(&last));
    let mut blocked = query.clone();
    blocked["blockedDoors"] = json!([{"level":0,"x":3107,"z":3162}]);
    let (status, _, closed) = call(&mut client, Method::POST, "/query", blocked).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(closed["waypoints"].as_array().unwrap().last(), Some(&last));
    assert_eq!(
        call(&mut client, Method::POST, "/query", query).await.2,
        open
    );
}
