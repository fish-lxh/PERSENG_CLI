# -*- coding: utf-8 -*-
import baostock as bs
lg = bs.login()

code = 'sh.600584'

# 查一下杜邦分析返回的字段名
rs = bs.query_dupont_data(code, year=2025, quarter=4)
print('字段列表:')
print(' ', rs.fields)
print()

# 同时返回真实数据
print('数据行:')
while (rs.error_code == '0') and rs.next():
    row = rs.get_row_data()
    for i, (f, v) in enumerate(zip(rs.fields, row)):
        print(f'  [{i}] {f}: {v}')

bs.logout()
