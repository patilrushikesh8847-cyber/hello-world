CREATE OR REPLACE VIEW invoice_balances WITH (security_invoker = true) AS
SELECT i.id,i.student_id,i.description,i.amount,
       coalesce(sum(p.amount),0)::numeric(12,2) AS paid,
       (i.amount-coalesce(sum(p.amount),0))::numeric(12,2) AS balance,
       i.due_date,i.created_at
FROM invoices i LEFT JOIN payments p ON p.invoice_id=i.id
GROUP BY i.id;

REVOKE ALL ON TABLE invoice_balances FROM anon, authenticated;
