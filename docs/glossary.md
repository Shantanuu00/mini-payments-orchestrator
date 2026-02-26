Each payment_id is you internal payment intent. It can have multiple attempts because:
*first attempt timed out (unknown)
*you retried safely
*you failed over to another gateway
*you tried again after a minute
*So it’s normal to have:
*one payment
*many attempts

The real rule is:
✅ A payment_id can have many attempts
✅ But it must have at most one successful attempt
That’s “no double charge”.
So in short payment_id should have one successful attempt.
**********************************************
Idempotency key: Idempotency keys arrives when merchant backend calls your confirm endpoint.And now this Idempotency key is resused during retries. 
Idempotency is needed because during confirm is where duplicates happens. It may be due to several reasons(frontend retries , client timeout , user double clicks, network issues) During confirm , you may call gateway twice. Multiple identical requests produce only one effect and one consistent response. During confirmation you create a attempt record, call the connector/gateway,update the payment status accordingly. (payment id is unique but it is created per attempt, it does not stop you from creating second attempt.The idempotency prevents creating a second attempt for the same logical confirm call)
 So:

payment_id = identity of payment
attempt_id = identity of one try
idempotency_key = identity of the client request/action
Three different identities for three different purposes. 
******************************************************
Merchant backend: client of the orchestrator.
Your orchestrator: API service you built.
Gateway(Stripe razorpay): External dependency. 
******************************************************
payments have states: 
created-non-terminal
processing-non-terminal
succeeded-terminal
failed- terminal
manual review-terminal

Non - terminal means payment still in progress and can change. 
Terminal means payment is finished.
* terminal states do not regress(go backwards) it should never go back to the non terminal states

******************************************************
State machines: 
Succeeded: If payment is succeeded, you are not allowed to “confirm” again.and return success immediately(do not call gateway). 
If payment is processing, confirm might be allowed only in limited safe ways.
If payment is failed, maybe you allow a new attempt(retry allows new policy).
If status is created. proceed to call gateway. 
********************************************
Who is the “connector”?
Connector = your adapter module that talks to a gateway.
Example:
StripeConnector knows how to call Stripe API
RazorpayConnector knows how to call Razorpay API
MockConnector simulates behavior for testing
Your orchestrator calls a connector; connector calls the gateway API.
Webhook handler must be idempotent. 
Downstream actions: things your system triggers after success
********************************************

Webhooks deep dive:
the gateway calling you informing about events.
Normal API:you->Gatway
Webhook: Gateway->You(Webhooks are reverse API call)
Payment Flow With Webhook:
Merchant → Orchestrator → Gateway
                      |
                      | (later)
                      ↓
                 Webhook Event
                      ↓
                 Orchestrator updates DB

Webhooks can arrive late ,twice, arrive out of order, never arrive.They are push based. gatway tells you. eventually consistent. Truth may arrive later. Without webhooks you must poll gateway continuously.Webhook idempotency prevent duplicate event processing. 
*Confirm Idempotency prevents you approaching gateway twice.
*Webhook Idempotency prevents Gateway-> you twice.
Your orchestrator must be idempotent in both directions.                  




