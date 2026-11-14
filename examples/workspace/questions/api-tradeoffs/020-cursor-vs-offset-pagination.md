# Cursor or offset pagination: which would you use for a large, changing list?

## Short Answer
Cursor pagination for large or fast-changing data. Offset pagination gets slower as the offset grows, because the database still reads and skips the earlier rows, and it shows duplicates or skips items when rows are inserted or deleted between pages. A cursor encodes the last seen sort key (for example created_at plus id) and the next query asks for rows after it, using an index. Offset is fine for small, stable lists or when users need to jump to page 7.

## Going Deeper
A strong answer makes the sort key unique (add the id as a tie breaker), keeps the cursor opaque to clients (base64 of the key), backs the query with a composite index that matches the sort, and admits the trade-off: no total count and no random page jumps. It may mention returning a has-more flag by fetching one extra row.
