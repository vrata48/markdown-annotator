# Mermaid Test

Some intro text. Select this sentence to check annotations still work.

## Flowchart

```mermaid
flowchart TD
    A[Open File] --> B{Valid .md?}
    B -->|Yes| C[Render Markdown]
    B -->|No| D[Show error]
    C --> E[Render Mermaid blocks]
```

## Sequence

```mermaid
sequenceDiagram
    Browser->>Server: GET /api/pick
    Server->>OS: native open dialog
    OS-->>Server: chosen path
    Server-->>Browser: file content
```

## Regular code (should still highlight, not render)

```python
def hello():
    print("still a normal code block")
```
