trait Notifier { fn send_sms(&self, text:&str)->Result<(),()> { self.validate_phone(text)?; self.send(text); Ok(()) } fn validate_phone(&self,_:&str)->Result<(),()>{Ok(())} fn send(&self,_:&str) {} }
