# Schema-dialect probe — 20261025T000824Z

## kilo-poolside

```
provider=kilo model=poolside/laguna-s-2.1:free key=env:KILO_API_KEY

  ✗ union-nullable: REJECTED — provider HTTP 401: {"error":{"code":"INVALID_TOKEN","message":"Your authentication token is invalid. Please sign in again."},"error_type":"authentication_required"}
  ✗ adjacency: REJECTED — provider HTTP 401: {"error":{"code":"INVALID_TOKEN","message":"Your authentication token is invalid. Please sign in again."},"error_type":"authentication_required"}
  ✗ adjacency-nullable-free: REJECTED — provider HTTP 401: {"error":{"code":"INVALID_TOKEN","message":"Your authentication token is invalid. Please sign in again."},"error_type":"authentication_required"}

0/3 dialects accepted by kilo/poolside/laguna-s-2.1:free
```

## groq-gpt-oss

```
SKIPPED — GROQ_API_KEY is the EXPOSED key (docs/runbooks/credential-rotation.md §2).
Set P31_PROBE_GROQ=1 to run this leg again, after the rotation.
```

## openrouter-poolside

```
provider=openrouter model=poolside/laguna-s-2.1:free key=env:OPENROUTER_API_KEY

  ✗ union-nullable: REJECTED — 429 rate limit
  ✓ adjacency: ACCEPTED (3874ms, 147 tokens) served=poolside/laguna-s-2.1:free
      output: I'll create a Badge component with the specified properties.  ```jsx <Badge variant="success">Active</Badge> ```  This Badge component has: - Label: "Active" - 
  ✓ adjacency-nullable-free: ACCEPTED (3006ms, 172 tokens) served=poolside/laguna-s-2.1:free
      output: I'll create a single Badge node with the specified label and variant.  ```json {   "type": "Badge",   "props": {     "label": "Active",     "variant": "success"

2/3 dialects accepted by openrouter/poolside/laguna-s-2.1:free
```

