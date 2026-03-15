pub enum E2eCborValue<'a> {
    Int(i64),
    Str(&'a str),
    TypedBytes(&'a [u8]),
    Map(Vec<(&'a str, E2eCborValue<'a>)>),
}

pub fn encode(val: &E2eCborValue<'_>) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_value(val, &mut buf);
    buf
}

fn encode_value(val: &E2eCborValue<'_>, buf: &mut Vec<u8>) {
    match val {
        E2eCborValue::Int(n) => encode_int(*n, buf),
        E2eCborValue::Str(s) => encode_str(s, buf),
        E2eCborValue::TypedBytes(bytes) => {
            encode_head(6, 64, buf);
            encode_head(2, bytes.len() as u64, buf);
            buf.extend_from_slice(bytes);
        }
        E2eCborValue::Map(pairs) => {
            buf.push(0xb9);
            buf.extend_from_slice(&(pairs.len() as u16).to_be_bytes());
            for (key, value) in pairs {
                encode_str(key, buf);
                encode_value(value, buf);
            }
        }
    }
}

fn encode_int(value: i64, buf: &mut Vec<u8>) {
    if value >= 0 {
        encode_head(0, value as u64, buf);
    } else {
        encode_head(1, (-1 - value) as u64, buf);
    }
}

fn encode_str(value: &str, buf: &mut Vec<u8>) {
    encode_head(3, value.len() as u64, buf);
    buf.extend_from_slice(value.as_bytes());
}

fn encode_head(major: u8, value: u64, buf: &mut Vec<u8>) {
    let mt = major << 5;
    if value <= 23 {
        buf.push(mt | value as u8);
    } else if value <= 0xff {
        buf.push(mt | 24);
        buf.push(value as u8);
    } else if value <= 0xffff {
        buf.push(mt | 25);
        buf.extend_from_slice(&(value as u16).to_be_bytes());
    } else if value <= 0xffff_ffff {
        buf.push(mt | 26);
        buf.extend_from_slice(&(value as u32).to_be_bytes());
    } else {
        buf.push(mt | 27);
        buf.extend_from_slice(&value.to_be_bytes());
    }
}
