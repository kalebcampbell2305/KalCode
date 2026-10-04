use super::*;
use kalcode_secure_store::MemorySecretStore;
use std::io::{Read, Write};

fn adapter() -> (tempfile::TempDir, OpenAiIntegrations) {
    let directory = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let broker = Arc::new(
        IntegrationBroker::open(directory.path().join("integrations.db"), secrets.clone()).unwrap(),
    );
    let adapter = OpenAiIntegrations::new(broker, secrets).unwrap();
    adapter
        .configure_key(Some(SecretString::new("sk-user-owned-test-only")))
        .unwrap();
    (directory, adapter)
}

/// Real HTTP parser/client path, using only synthetic credentials and a loopback server.
fn server(status: u16, body: Value) -> (String, std::sync::mpsc::Receiver<String>) {
    server_sequence(vec![(status, body)])
}

fn server_sequence(responses: Vec<(u16, Value)>) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let length = stream.read(&mut chunk).unwrap();
                if length == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..length]);
                if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let count = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + count {
                        break;
                    }
                }
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            let body = body.to_string();
            write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    (format!("http://{address}/v1/responses"), receiver)
}
fn scope() -> ToolScope {
    ToolScope {
        workspace_id: "workspace".into(),
        surface: kalcode_integrations::Surface::Code,
        session_id: "real-terminal-session".into(),
    }
}

#[tokio::test]
async fn user_key_only_store_false_and_lazy_definitions() {
    let (_directory, mut adapter) = adapter();
    let (endpoint, requests) = server(
        200,
        json!({"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"No tools were called."}]}]}),
    );
    adapter.endpoint = endpoint;
    let result = adapter
        .query(scope(), "gpt-6-astra".into(), "Check my deployments".into())
        .await
        .unwrap();
    assert!(matches!(
        result,
        TurnOutcome::Completed { tool_calls: 0, .. }
    ));
    let request = requests.recv().unwrap();
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["store"], false);
    assert_eq!(body["parallel_tool_calls"], false);
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    assert_eq!(body["tools"][0]["type"], "tool_search");
    assert!(!body.to_string().contains("sk-user-owned-test-only"));
    assert!(!body.to_string().contains("previous_response_id"));
}

#[tokio::test]
async fn no_user_key_never_attempts_http() {
    let (_directory, adapter) = adapter();
    adapter.configure_key(None).unwrap();
    assert!(matches!(
        adapter
            .query(scope(), "gpt-6-astra".into(), "hello".into())
            .await,
        Err(Error::NotConfigured)
    ));
}

#[tokio::test]
async fn invented_function_cannot_execute() {
    let (_directory, mut adapter) = adapter();
    let (endpoint, _requests) = server(
        200,
        json!({"output":[{"type":"function_call","call_id":"call_1","name":"delete_database","arguments":"{}"}]}),
    );
    adapter.endpoint = endpoint;
    assert!(matches!(
        adapter
            .query(scope(), "gpt-6-astra".into(), "Check deployment".into())
            .await,
        Err(Error::Protocol)
    ));
}

#[tokio::test]
async fn upstream_error_body_is_never_exposed() {
    let (_directory, mut adapter) = adapter();
    let (endpoint, _requests) = server(
        401,
        json!({"error":{"message":"Your token sk-private-user-data leaked"}}),
    );
    adapter.endpoint = endpoint;
    let error = adapter
        .query(scope(), "gpt-6-astra".into(), "hello".into())
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Authentication));
    assert!(!error.to_string().contains("sk-private"));
}

#[test]
fn strict_schemas_preserve_optional_semantics() {
    assert!(strict_compatible(
        &json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false})
    ));
    assert!(!strict_compatible(
        &json!({"type":"object","properties":{"id":{"type":"string"}},"additionalProperties":false})
    ));
    assert!(!strict_compatible(
        &json!({"type":"object","properties":{},"required":[]})
    ));
    assert!(!supports_tool_search("gpt-4.1"));
    assert!(!supports_tool_search("made-up-model"));
}

#[test]
fn fallback_search_is_strict_and_tunnel_never_disables_approval() {
    let fallback = search_definition(false);
    assert_eq!(fallback["strict"], true);
    assert_eq!(fallback["parameters"]["additionalProperties"], false);
}

fn tunnel(adapter: &OpenAiIntegrations) -> Integration {
    use kalcode_integrations::{AccessGrant, IntegrationInput};
    let record = adapter
        .broker
        .save(
            IntegrationInput {
                id: None,
                name: "Production".into(),
                kind: IntegrationKind::SecureMcpTunnel,
                endpoint: "tunnel_0123456789abcdef0123456789abcdef".into(),
                tools: vec![],
                trusted_read_tools: vec![],
            },
            None,
        )
        .unwrap();
    adapter.broker.record_tunnel_discovery(&record.id,vec![ToolDefinition {
        name:"restart_service".into(),description:"Restart the selected service".into(),
        input_schema:json!({"type":"object","properties":{"service":{"type":"string"}},"required":["service"],"additionalProperties":false}),risk:Risk::Sensitive,
    }]).unwrap();
    adapter
        .broker
        .set_grants(
            &record.id,
            vec![AccessGrant {
                workspace_id: scope().workspace_id,
                surface: scope().surface,
                session_id: scope().session_id,
                tool_names: vec!["restart_service".into()],
            }],
        )
        .unwrap()
}

#[tokio::test]
async fn sensitive_tunnel_resume_is_exact_scoped_and_single_use() {
    let (_directory, mut adapter) = adapter();
    let integration = tunnel(&adapter);
    let args = json!({"service":"production"});
    let approval = adapter
        .broker
        .authorize_external(
            scope(),
            integration.id.clone(),
            "restart_service".into(),
            args.clone(),
            None,
        )
        .unwrap()
        .unwrap();
    let call_id = "mcpr_exact_1";
    let turn = Turn {
        scope: scope(),
        model: "gpt-6-astra".into(),
        input: vec![
            json!({"type":"mcp_approval_request","id":call_id,"name":"restart_service","server_label":"production","arguments":args.to_string()}),
        ],
        loaded: HashMap::new(),
        steps: 1,
        tool_calls: 0,
        seen: HashSet::from([call_id.to_string()]),
        created: Instant::now(),
        pending: None,
        tunnels: HashMap::from([("production".into(), integration.id.clone())]),
    };
    let result = adapter
        .pause(
            turn,
            call_id.into(),
            DiscoveredTool {
                integration_id: integration.id.clone(),
                integration_name: integration.name.clone(),
                tool: integration.capabilities[0].clone(),
            },
            args,
            approval.clone(),
            true,
        )
        .unwrap();
    let TurnOutcome::ApprovalRequired { turn_id, .. } = result else {
        panic!("expected approval")
    };
    let mut wrong_scope = scope();
    wrong_scope.session_id = "different-terminal".into();
    assert!(matches!(
        adapter.resume(wrong_scope, turn_id.clone()).await,
        Err(Error::Expired)
    ));
    adapter.broker.approve(&approval.id).unwrap();
    let (endpoint, requests) = server(
        200,
        json!({"output":[
            {"type":"mcp_call","id":"mcp_result","approval_request_id":call_id,"name":"restart_service","server_label":"production","arguments":"{\"service\":\"production\"}","output":"restarted"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Production restarted."}]}
        ]}),
    );
    adapter.endpoint = endpoint;
    assert!(matches!(
        adapter.resume(scope(), turn_id.clone()).await.unwrap(),
        TurnOutcome::Completed { tool_calls: 1, .. }
    ));
    assert!(matches!(
        adapter.resume(scope(), turn_id).await,
        Err(Error::Expired)
    ));
    let request = requests.recv().unwrap();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["tools"][1]["require_approval"], "always");
    assert_eq!(
        body["tools"][1]["allowed_tools"],
        json!(["restart_service"])
    );
    assert!(body["tools"][1].get("server_url").is_none());
    assert_eq!(
        body["input"][1],
        json!({"type":"mcp_approval_response","approval_request_id":call_id,"approve":true})
    );
}

#[tokio::test]
async fn tunnel_discovery_requires_real_list_tools() {
    let (_directory, mut adapter) = adapter();
    let integration = tunnel(&adapter);
    let (endpoint, _requests) = server(
        200,
        json!({"output":[{"type":"message","content":[{"type":"output_text","text":"The tunnel is healthy"}]}]}),
    );
    adapter.endpoint = endpoint;
    assert!(matches!(
        adapter
            .discover_tunnel(integration.id, "gpt-6-astra".into())
            .await,
        Err(Error::Protocol)
    ));
}

#[tokio::test]
async fn lazy_search_loads_actual_granted_function_then_pauses_before_mutation() {
    use kalcode_integrations::{AccessGrant, CustomTool, IntegrationInput};
    let (_directory, mut adapter) = adapter();
    let integration = adapter.broker.save(IntegrationInput {
        id:None,name:"Release service".into(),kind:IntegrationKind::CustomApi,endpoint:"https://api.example.com".into(),trusted_read_tools:vec![],
        tools:vec![CustomTool {name:"restart_service".into(),description:"Restart service".into(),method:"POST".into(),path:"/restart".into(),risk:Risk::Sensitive,
            input_schema:json!({"type":"object","properties":{"service":{"type":"string"}},"required":["service"],"additionalProperties":false})}],
    },None).unwrap();
    adapter
        .broker
        .set_grants(
            &integration.id,
            vec![AccessGrant {
                workspace_id: scope().workspace_id,
                surface: scope().surface,
                session_id: scope().session_id,
                tool_names: vec!["restart_service".into()],
            }],
        )
        .unwrap();
    let (endpoint, requests) = server_sequence(vec![
        (
            200,
            json!({"output":[{"type":"tool_search_call","execution":"client","call_id":"search_1","status":"completed","arguments":{"goal":"restart"}}]}),
        ),
        (
            200,
            json!({"output":[{"type":"function_call","call_id":"action_1","name":"kalcode_tool_0","arguments":"{\"service\":\"production\"}"}]}),
        ),
    ]);
    adapter.endpoint = endpoint;
    let result = adapter
        .query(scope(), "gpt-6-astra".into(), "Restart production".into())
        .await
        .unwrap();
    let TurnOutcome::ApprovalRequired { approval, .. } = result else {
        panic!("mutation must pause")
    };
    assert_eq!(approval.tool_name, "restart_service");
    assert_eq!(approval.arguments_preview, json!({"service":"production"}));
    let _first = requests.recv().unwrap();
    let second = requests.recv().unwrap();
    let body: Value = serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
    let loaded = &body["input"][2];
    assert_eq!(loaded["type"], "tool_search_output");
    assert_eq!(loaded["tools"][0]["name"], "kalcode_tool_0");
    assert_eq!(loaded["tools"][0]["strict"], true);
    assert_eq!(loaded["tools"][0]["defer_loading"], true);
    assert_eq!(adapter.broker.pending_approvals().unwrap().len(), 1);
}

#[tokio::test]
async fn expired_account_never_reads_key_or_dispatches() {
    let (_directory, adapter) = adapter();
    let adapter = adapter.with_authority(Arc::new(|| false));
    assert!(matches!(
        adapter
            .query(scope(), "gpt-6-astra".into(), "hello".into())
            .await,
        Err(Error::ScopeExpired)
    ));
    assert!(matches!(adapter.configured(), Err(Error::ScopeExpired)));
}

#[tokio::test]
async fn closed_or_restricted_session_never_dispatches() {
    let (_directory, adapter) = adapter();
    let adapter = adapter.with_scope_authority(Arc::new(|scope| {
        scope.session_id == "still-running-session"
    }));
    assert!(matches!(
        adapter
            .query(scope(), "gpt-6-astra".into(), "Restart production".into())
            .await,
        Err(Error::ScopeExpired)
    ));
    assert!(matches!(
        adapter.resume(scope(), "pending-turn".into()).await,
        Err(Error::ScopeExpired)
    ));
}
