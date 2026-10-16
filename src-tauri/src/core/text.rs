/// 按字节上限截断字符串，保证落在 UTF-8 字符边界上（不会因多字节字符 panic）
pub fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_string_unchanged() {
        assert_eq!(truncate_bytes("abc", 10), "abc");
    }

    #[test]
    fn ascii_cut_exact() {
        assert_eq!(truncate_bytes("abcdef", 3), "abc");
    }

    #[test]
    fn cut_inside_multibyte_char_does_not_panic() {
        // 每个汉字 3 字节；上限 4 落在第二个字中间，应回退到 3
        assert_eq!(truncate_bytes("你好世界", 4), "你");
        assert_eq!(truncate_bytes("你好世界", 5), "你");
        assert_eq!(truncate_bytes("你好世界", 6), "你好");
    }

    #[test]
    fn zero_limit() {
        assert_eq!(truncate_bytes("你好", 0), "");
    }
}
