//! The GraphQL Bellwether sends, and how Linear's nodes become output lines.

use serde_json::{json, Map, Value};

pub const PAGE: u32 = 50;
/// Done, canceled and duplicate issues are not open; the list leaves them out.
pub const CLOSED: [&str; 3] = ["completed", "canceled", "duplicate"];

const ISSUE_FIELDS: &str = "id identifier title url branchName priority updatedAt \
    state { name type color position } assignee { name displayName isMe } project { id name } \
    labels(first: 10) { nodes { name color } }";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Project,
    Mine,
    All,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "project" => Some(Scope::Project),
            "mine" => Some(Scope::Mine),
            "all" => Some(Scope::All),
            _ => None,
        }
    }
}

/// The filter for open issues in `scope`; `project` is required for `Scope::Project`.
pub fn filter(scope: Scope, project: Option<&str>) -> Value {
    let mut f = Map::new();
    f.insert("state".into(), json!({"type": {"nin": CLOSED}}));
    match scope {
        Scope::Project => {
            f.insert(
                "project".into(),
                json!({"id": {"eq": project.unwrap_or("")}}),
            );
        }
        Scope::Mine => {
            f.insert("assignee".into(), json!({"isMe": {"eq": true}}));
        }
        Scope::All => {}
    }
    Value::Object(f)
}

pub fn issues(filter: Value, after: Option<&str>) -> Value {
    json!({
        "query": format!(
            "query Issues($filter: IssueFilter, $after: String) {{ issues(first: {PAGE}, after: $after, \
             filter: $filter, orderBy: updatedAt) {{ nodes {{ {ISSUE_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }}"
        ),
        "variables": {"filter": filter, "after": after},
    })
}

pub fn search(term: &str, filter: Value, after: Option<&str>) -> Value {
    json!({
        "query": format!(
            "query Search($term: String!, $filter: IssueFilter, $after: String) {{ searchIssues(term: $term, \
             first: {PAGE}, after: $after, filter: $filter) {{ nodes {{ {ISSUE_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }}"
        ),
        "variables": {"term": term, "filter": filter, "after": after},
    })
}

pub fn issue(id: &str) -> Value {
    json!({
        "query": format!("query Issue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} description }} }}"),
        "variables": {"id": id},
    })
}

pub fn projects(after: Option<&str>) -> Value {
    json!({
        "query": format!(
            "query Projects($after: String) {{ projects(first: {PAGE}, after: $after, orderBy: updatedAt) {{ \
             nodes {{ id name url teams(first: 5) {{ nodes {{ key }} }} }} pageInfo {{ hasNextPage endCursor }} }} }}"
        ),
        "variables": {"after": after},
    })
}

fn str_or_null(v: &Value) -> Value {
    v.as_str().map_or(Value::Null, |s| json!(s))
}

/// One `linear-issue` line from an issue node.
pub fn issue_line(n: &Value) -> Value {
    let a = &n["assignee"];
    let assignee = a["displayName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| a["name"].as_str());
    let project = if n["project"].is_object() {
        json!({"id": str_or_null(&n["project"]["id"]), "name": str_or_null(&n["project"]["name"])})
    } else {
        Value::Null
    };
    let labels: Vec<Value> = n["labels"]["nodes"]
        .as_array()
        .map(|ls| {
            ls.iter()
                .map(
                    |l| json!({"name": str_or_null(&l["name"]), "color": str_or_null(&l["color"])}),
                )
                .collect()
        })
        .unwrap_or_default();
    json!({
        "type": "linear-issue",
        "id": str_or_null(&n["id"]),
        "identifier": str_or_null(&n["identifier"]),
        "title": str_or_null(&n["title"]),
        "url": str_or_null(&n["url"]),
        "branch": str_or_null(&n["branchName"]),
        "priority": n["priority"].as_f64().unwrap_or(0.0),
        "updated": str_or_null(&n["updatedAt"]),
        "state": {
            "name": str_or_null(&n["state"]["name"]),
            "type": str_or_null(&n["state"]["type"]),
            "color": str_or_null(&n["state"]["color"]),
            "position": n["state"]["position"].as_f64().unwrap_or(0.0),
        },
        "assignee": assignee.map_or(Value::Null, |s| json!(s)),
        "mine": a["isMe"].as_bool().unwrap_or(false),
        "project": project,
        "labels": labels,
    })
}

pub fn project_line(n: &Value) -> Value {
    let teams: Vec<Value> = n["teams"]["nodes"]
        .as_array()
        .map(|ts| ts.iter().map(|t| str_or_null(&t["key"])).collect())
        .unwrap_or_default();
    json!({
        "type": "linear-project",
        "id": str_or_null(&n["id"]),
        "name": str_or_null(&n["name"]),
        "url": str_or_null(&n["url"]),
        "teams": teams,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_per_scope() {
        let p = filter(Scope::Project, Some("p1"));
        assert_eq!(p["project"]["id"]["eq"], "p1");
        assert_eq!(
            p["state"]["type"]["nin"],
            json!(["completed", "canceled", "duplicate"])
        );
        assert!(p.get("assignee").is_none());
        let m = filter(Scope::Mine, None);
        assert_eq!(m["assignee"]["isMe"]["eq"], true);
        assert!(m.get("project").is_none());
        let a = filter(Scope::All, None);
        assert!(a.get("project").is_none() && a.get("assignee").is_none());
    }

    #[test]
    fn issue_line_reads_a_node() {
        let n = json!({"id":"u1","identifier":"PLA-1","title":"T","url":"https://x","branchName":"b",
            "priority":2,"updatedAt":"2026-11-08T00:00:00Z","state":{"name":"Todo","type":"unstarted","color":"#fff","position":1},
            "assignee":{"name":"N","displayName":"","isMe":true},"project":null,"labels":{"nodes":[{"name":"Bug","color":"#f00"}]}});
        let l = issue_line(&n);
        assert_eq!(l["identifier"], "PLA-1");
        assert_eq!(l["assignee"], "N");
        assert_eq!(l["mine"], true);
        assert_eq!(l["project"], Value::Null);
        assert_eq!(l["labels"][0]["name"], "Bug");
    }
}
